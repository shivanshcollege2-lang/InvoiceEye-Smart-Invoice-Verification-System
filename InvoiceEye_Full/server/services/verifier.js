function toScaledInteger(value, precision = 2) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const match = String(value).trim().match(/^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!match) return null;
  const sign = match[1] === '-' ? -1n : 1n;
  const fraction = match[3] || '';
  const exponent = Number(match[4] || 0) - fraction.length + precision;
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 30) return null;
  let scaled = BigInt(`${match[2]}${fraction}`);
  if (exponent >= 0) {
    scaled *= 10n ** BigInt(exponent);
  } else {
    const divisor = 10n ** BigInt(-exponent);
    const remainder = scaled % divisor;
    scaled /= divisor;
    if (remainder * 2n >= divisor) scaled += 1n;
  }
  return scaled * sign;
}

function toMinorUnits(value) {
  return toScaledInteger(value, 2);
}

function minorUnitsEqual(value, expected, tolerance = 100n) {
  const observed = toMinorUnits(value);
  return observed !== null && (observed >= expected
    ? observed - expected <= tolerance
    : expected - observed <= tolerance);
}

function moneyEqual(a, b, tolerance = 1) {
  const expected = toMinorUnits(b);
  const toleranceMinor = toMinorUnits(tolerance);
  return expected !== null && toleranceMinor !== null
    && minorUnitsEqual(a, expected, toleranceMinor);
}

function productMinorUnits(quantity, unitPrice) {
  const quantityHundredths = toScaledInteger(quantity, 2);
  const priceHundredths = toScaledInteger(unitPrice, 2);
  if (quantityHundredths === null || priceHundredths === null) return null;
  const product = quantityHundredths * priceHundredths;
  const cents = product / 100n;
  const remainder = product % 100n;
  return cents + (remainder >= 50n ? 1n : remainder <= -50n ? -1n : 0n);
}

function billedBase(invoice) {
  if (invoice.lineItems?.length) {
    return invoice.lineItems.reduce((sum, item) => {
      const lineTotal = productMinorUnits(item.quantity, item.unitPrice ?? item.unit_price);
      return lineTotal === null ? null : sum === null ? null : sum + lineTotal;
    }, 0n);
  }
  if (invoice.unitPrice == null || invoice.quantity == null) return null;
  return productMinorUnits(invoice.quantity, invoice.unitPrice);
}

function formatMinorUnits(value) {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function formatQuantityDifference(value) {
  if (value === null) return 'unknown';
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  const fraction = String(absolute % 100n).padStart(2, '0').replace(/0+$/, '');
  return `${sign}${absolute / 100n}${fraction ? `.${fraction}` : ''}`;
}

function normalizedDescription(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function verifyInvoice(invoice, po, duplicateInvoice = false, anomaly = {}) {
  const reasons = [];
  const checks = [];
  let risk = 0;
  let hardReject = false;

  const addCheck = (name, passed, message, score = 0, hard = false) => {
    checks.push({ name, passed, message });
    reasons.push(message);
    if (!passed) {
      risk += score;
      if (hard) hardReject = true;
    }
  };

  addCheck('invoice_number', Boolean(invoice.invoiceNumber && !String(invoice.invoiceNumber).startsWith('UNPARSED-')), Boolean(invoice.invoiceNumber && !String(invoice.invoiceNumber).startsWith('UNPARSED-')) ? 'Invoice number captured' : 'Invoice number is missing', 20);
  const vendorKnown = invoice.vendorId === undefined ? Boolean(invoice.vendor) : Boolean(invoice.vendorId);
  const unitPriceValid = invoice.unitPrice != null
    ? Number(invoice.unitPrice) > 0
    : Boolean(invoice.lineItems?.length) && invoice.lineItems.every(item => Number(item.unitPrice ?? item.unit_price) > 0);
  addCheck('vendor', vendorKnown, vendorKnown ? 'Vendor identified in vendor master' : invoice.vendor ? 'Vendor was not found in vendor master' : 'Vendor could not be identified', 35);
  addCheck('purchase_order', Boolean(invoice.poNumber), !invoice.poNumber ? 'Purchase-order number is missing' : 'Purchase-order number captured', 20);
  addCheck('quantity', Number(invoice.quantity) > 0, Number(invoice.quantity) > 0 ? 'Invoice quantity is valid' : 'Invoice quantity must be greater than zero', 20);
  addCheck('unit_price', unitPriceValid, unitPriceValid ? 'Invoice unit price is valid' : 'Invoice unit price must be greater than zero', 20);

  const invoiceBase = billedBase(invoice);
  if (invoice.subtotal == null || invoiceBase == null) {
    addCheck('subtotal_consistency', false, 'Invoice subtotal or line-item amounts could not be extracted', 30);
  } else {
    const subtotalMatches = minorUnitsEqual(invoice.subtotal, invoiceBase);
    addCheck('subtotal_consistency', subtotalMatches, subtotalMatches ? 'Subtotal reconciles with invoice line items' : 'Invoice subtotal does not reconcile with invoice line items', 30);
  }

  const invoiceSubtotal = invoice.subtotal == null ? invoiceBase : toMinorUnits(invoice.subtotal);
  const invoiceTax = toMinorUnits(invoice.tax || 0);
  if (invoice.total == null || invoiceSubtotal === null || invoiceTax === null) {
    addCheck('total_consistency', false, 'Invoice total or supporting amounts could not be extracted', 40);
  } else {
    const totalMatches = minorUnitsEqual(invoice.total, invoiceSubtotal + invoiceTax);
    addCheck('total_consistency', totalMatches, totalMatches ? 'Invoice total is mathematically consistent' : 'Invoice total does not reconcile with subtotal and tax', 40);
  }

  if (!po) {
    addCheck('po_match', false, 'No matching purchase order was found', 60, false);
  } else {
    const expectedQty = po.items.reduce((sum, item) => sum + (toScaledInteger(item.quantity, 2) ?? 0n), 0n);
    const observedQty = toScaledInteger(invoice.quantity, 2);
    const expectedBase = po.items.reduce((sum, item) => {
      const lineTotal = productMinorUnits(item.quantity, item.unitPrice ?? item.unit_price ?? 0);
      return lineTotal === null ? sum : sum + lineTotal;
    }, 0n);

    if (po.vendor_id != null) {
      const vendorMatchesPO = vendorKnown && String(invoice.vendorId) === String(po.vendor_id);
      addCheck('vendor_po_match', vendorMatchesPO, vendorMatchesPO ? 'Purchase order belongs to the identified vendor' : 'Purchase order belongs to a different or unidentified vendor', 40);
    }

    if (po.currency && invoice.currency) {
      const currencyMatches = String(po.currency).toUpperCase() === String(invoice.currency).toUpperCase();
      addCheck('currency_match', currencyMatches, currencyMatches ? 'Invoice currency matches purchase order' : `Invoice currency ${invoice.currency} differs from purchase-order currency ${po.currency}`, 40);
    }

    if (observedQty !== null && observedQty === expectedQty) {
      addCheck('quantity_match', true, 'Quantity matches purchase order');
    } else if (observedQty !== null && observedQty > expectedQty) {
      addCheck('quantity_match', false, `Invoice quantity exceeds purchase-order quantity by ${formatQuantityDifference(observedQty - expectedQty)} units`, 35);
    } else if (observedQty === null) {
      addCheck('quantity_match', false, 'Invoice quantity could not be compared with purchase order', 20);
    } else {
      addCheck('quantity_match', false, `Invoice quantity is below purchase-order quantity by ${formatQuantityDifference(expectedQty - observedQty)} units`, 20);
    }

    if (po.items.length === 1) {
      const expectedUnitPrice = Number(po.items[0].unitPrice ?? po.items[0].unit_price);
      const observedUnitPrice = invoice.unitPrice ?? (invoice.lineItems?.length === 1 ? invoice.lineItems[0].unitPrice : null);
      if (observedUnitPrice == null) {
        addCheck('price_match', false, 'Invoice unit price could not be extracted', 20);
      } else if (moneyEqual(observedUnitPrice, expectedUnitPrice)) {
        addCheck('price_match', true, 'Unit price matches purchase order');
      } else {
        const observedMinor = toMinorUnits(observedUnitPrice);
        const expectedMinor = toMinorUnits(expectedUnitPrice);
        const difference = observedMinor === null || expectedMinor === null ? 0n : observedMinor - expectedMinor;
        addCheck('price_match', false, `Unit price differs from purchase-order price by ${formatMinorUnits(difference < 0n ? -difference : difference)}`, 35, difference > 0n);
      }
    } else if (invoice.lineItems?.length) {
      const allItemsMatch = invoice.lineItems.every(item => {
        const matchingPOItem = po.items.find(poItem => item.sku && poItem.sku
          ? String(item.sku).trim().toLowerCase() === String(poItem.sku).trim().toLowerCase()
          : normalizedDescription(item.description) === normalizedDescription(poItem.description));
        return matchingPOItem && moneyEqual(item.unitPrice ?? item.unit_price, matchingPOItem.unitPrice ?? matchingPOItem.unit_price);
      });
      addCheck('price_match', allItemsMatch, allItemsMatch ? 'Invoice line prices match purchase-order items' : 'Invoice line items or prices do not match the purchase order', 35);
    } else {
      addCheck('price_match', false, 'Line items are required to verify prices against this multi-item purchase order', 20);
    }

    if (invoiceBase != null) {
      const poValueMatches = minorUnitsEqual(formatMinorUnits(invoiceBase), expectedBase);
      addCheck('po_value_match', poValueMatches, poValueMatches ? 'Billed base amount matches purchase-order value' : 'Expected purchase-order amount differs from billed base amount', 25);
    }
  }

  addCheck('duplicate', !duplicateInvoice, !duplicateInvoice ? 'No duplicate invoice number detected' : 'Potential duplicate invoice number detected', 55, duplicateInvoice);

  if (anomaly.score > 0) {
    reasons.push(anomaly.message);
    risk += anomaly.score;
    checks.push({ name:'anomaly', passed:false, message:anomaly.message });
  } else {
    checks.push({ name:'anomaly', passed:true, message:'No supporting anomaly signal detected' });
    reasons.push('No supporting anomaly signal detected');
  }

  risk = Math.min(99, Math.max(0, Math.round(risk)));
  let status = 'ACCEPTED';
  if (hardReject || risk >= 85) status = 'REJECTED';
  else if (risk >= 35) status = 'NEEDS REVIEW';

  return { status, riskScore: risk, duplicate: duplicateInvoice, reasons, checks };
}

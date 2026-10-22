export function anomalySignal(invoice, historicalInvoices = []) {
  if (!historicalInvoices.length) return { score: 0, message: '' };
  const sameVendor = historicalInvoices.filter(x => x.vendor_id === invoice.vendorId || x.vendor_id === invoice.vendor_id);
  if (!sameVendor.length) return { score: 0, message: '' };
  const avg = sameVendor.reduce((s, x) => s + Number(x.total || 0), 0) / sameVendor.length;
  const current = Number(invoice.total || 0);
  if (avg > 0 && current > avg * 2.5) return { score: 15, message: 'Invoice total is materially higher than the vendor historical average; reviewer attention recommended' };
  return { score: 0, message: '' };
}

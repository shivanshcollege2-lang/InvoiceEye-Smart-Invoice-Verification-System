USE invoiceeye;

INSERT INTO vendors (vendor_id,name,email,category,tax_id,status) VALUES
('V001','Apex Office Supplies','billing@apex.example','Office Supplies','27ABCDE1234F1Z5','ACTIVE'),
('V002','Nova Components Ltd.','accounts@nova.example','Electronics','27NOVA1234F1Z2','ACTIVE'),
('V003','Prime Facility Services','finance@prime.example','Services','27PRIME1234F1Z9','ACTIVE')
ON DUPLICATE KEY UPDATE name=VALUES(name),email=VALUES(email),category=VALUES(category),tax_id=VALUES(tax_id),status=VALUES(status);

INSERT INTO purchase_orders (po_id,vendor_id,po_date,status,currency,notes) VALUES
('PO-1001','V001','2026-09-01','APPROVED','INR','Office supplies procurement'),
('PO-1002','V002','2026-09-02','APPROVED','INR','Cable procurement'),
('PO-1003','V003','2026-09-03','APPROVED','INR','Monthly facility maintenance')
ON DUPLICATE KEY UPDATE vendor_id=VALUES(vendor_id),po_date=VALUES(po_date),status=VALUES(status),currency=VALUES(currency),notes=VALUES(notes);

INSERT INTO po_items (po_id,sku,description,quantity,unit_price)
SELECT 'PO-1001','PEN-01','Premium Ball Pens',100,500
WHERE NOT EXISTS (SELECT 1 FROM po_items WHERE po_id='PO-1001');
INSERT INTO po_items (po_id,sku,description,quantity,unit_price)
SELECT 'PO-1002','CAB-07','USB-C Cables',50,850
WHERE NOT EXISTS (SELECT 1 FROM po_items WHERE po_id='PO-1002');
INSERT INTO po_items (po_id,sku,description,quantity,unit_price)
SELECT 'PO-1003','SERV-09','Facility Maintenance',10,2000
WHERE NOT EXISTS (SELECT 1 FROM po_items WHERE po_id='PO-1003');

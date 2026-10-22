export function notFound(req, res) {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
}

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err.status && err.status < 500) {
    return res.status(err.status).json({ message: err.message || 'Request could not be processed' });
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ message: 'Invoice file exceeds the 8 MB upload limit' });
  }
  console.error('InvoiceEye request failed', err);
  res.status(500).json({ message: 'Internal server error' });
}

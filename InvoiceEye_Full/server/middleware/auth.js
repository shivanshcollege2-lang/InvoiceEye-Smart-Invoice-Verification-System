import jwt from 'jsonwebtoken';
import { getPool } from '../db/index.js';

const SECRET = process.env.JWT_SECRET || 'invoiceeye-development-secret';

export function signToken(user) {
  return jwt.sign({ id: user.user_id, email: user.email, role: user.role, name: user.name }, SECRET, { expiresIn: '8h' });
}

export async function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ message: 'Authentication required' });
  try {
    req.user = jwt.verify(token, SECRET);
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
  const [rows] = await getPool().query(
    'SELECT user_id FROM users WHERE user_id=? AND is_active=1',
    [req.user.id]
  );
  if (!rows.length) return res.status(401).json({ message: 'Account is inactive' });
  next();
}

export function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'You do not have permission for this operation' });
    }
    next();
  };
}

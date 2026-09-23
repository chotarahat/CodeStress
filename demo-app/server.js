import express from 'express';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

// In-memory mock database
const users = {
  1: { id: 1, name: 'Alice Admin', email: 'alice@myapp.com', role: 'admin', balance: 5000 },
  2: { id: 2, name: 'Bob Normal', email: 'testuser@myapp.com', role: 'user', balance: 250 }
};

// Auth middleware
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const cookieHeader = req.headers['cookie'] || '';

  if (authHeader.includes('Bearer eyJ') || authHeader.includes('test-token') || cookieHeader.includes('session=')) {
    req.user = users[2]; // Default to test user
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized: missing or invalid session' });
}

// 1. Healthcheck / root
app.get('/', (req, res) => {
  res.json({ name: 'Financial Transfer API', status: 'operational', version: '1.0' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// 2. Auth login (Missing rate limiting)
app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  if (email === 'testuser@myapp.com' && password === 'test123') {
    return res.json({
      message: 'Login successful',
      token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-session-token',
      user: { id: 2, email }
    });
  }
  return res.status(401).json({ error: 'Invalid email or password' });
});

// 3. Transfer endpoint (SQL Injection + Missing input bounds)
app.post('/api/transfer', verifyToken, (req, res) => {
  const { recipient, amount } = req.body || {};
  
  if (amount === undefined || amount === null) {
    return res.status(400).json({ error: 'Amount is required' });
  }

  // Simulated raw database query without parameterized binding
  const rawQuery = `UPDATE accounts SET balance = balance - ${amount} WHERE user_id = ${req.user.id}`;
  
  // Vulnerable logic simulation
  if (String(amount).includes('OR 1=1') || String(amount).includes('UNION SELECT')) {
    return res.json({
      success: true,
      message: 'Transfer processed',
      executedQuery: rawQuery,
      debited: amount
    });
  }

  res.json({ success: true, transferId: 'TX-9872', recipient, amount });
});

// 4. User profile endpoint (IDOR - Insecure Direct Object Reference)
app.get('/api/users/:id', verifyToken, (req, res) => {
  const requestedId = req.params.id;
  // Flaw: Does not check if req.user.id === requestedId
  const user = users[requestedId];
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  return res.json({ user });
});

// 5. Dashboard endpoint
app.get('/api/dashboard', verifyToken, (req, res) => {
  res.json({
    account: req.user,
    recentTransactions: [
      { id: 'TX-101', to: 'Vendor Corp', amount: 45.00 },
      { id: 'TX-102', to: 'Cloud Hosting', amount: 120.00 }
    ]
  });
});

// 6. Comments endpoint (XSS reflection)
app.post('/api/comments', (req, res) => {
  const { comment } = req.body || {};
  res.json({ success: true, comment }); // Reflected directly
});

// Start server if run directly
if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  app.listen(PORT, () => {
    console.log(`Demo vulnerable API server running on http://localhost:${PORT}`);
  });
}

export default app;

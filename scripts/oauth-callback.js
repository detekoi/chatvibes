import express from 'express';

const app = express();
const PORT = 3000;

app.get('/callback', (req, res) => {
  const code = req.query.code;
  console.log('🔑 Authorization code:', code);
  res.send('Got the code! Check your terminal and then close this window.');
  // You could even exit the process here if you like:
  // process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Listening for OAuth callbacks at http://localhost:${PORT}/callback`);
});
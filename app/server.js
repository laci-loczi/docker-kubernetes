const express = require('express');
const app = express();
const PORT = 3000;

app.get('/', (req, res) => {
    // Itt a változás: res.json helyett res.send HTML kóddal
    res.send(`
        <html>
        <head>
            <style>
                body { font-family: sans-serif; background-color: #2c3e50; color: white; text-align: center; padding-top: 50px; }
                .card { background-color: #34495e; padding: 20px; border-radius: 10px; display: inline-block; }
                h1 { color: #2ecc71; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>🚀 SIKER! Működik a Kubernetes!</h1>
                <p>Ezt az oldalt a Jenkins frissítette automatikusan.</p>
                <hr>
                <p>Én vagyok a Pod: <strong>${process.env.HOSTNAME}</strong></p>
            </div>
        </body>
        </html>
    `);
});

app.listen(PORT, () => console.log(`Backend running on ${PORT}`));
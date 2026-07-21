const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/', (req, res) => res.send('VyralJin Server OK'));
app.get('/health', (req, res) => res.json({ status: 'ok', ffmpeg: 'ready' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('VyralJin Server v2.4 on port ' + PORT));

const https = require('https');

function pingHealthEndpoint() {
    const options = {
        hostname: 'messenger.ukporpatriotsuk.org',
        path: '/health',
        method: 'GET',
        timeout: 20000, // 20 seconds timeout
        rejectUnauthorized: false // In case of self-signed certificate
    };

    const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
            console.log(`[${new Date().toISOString()}] Health check successful. Status: ${res.statusCode}`);
        });
    });

    req.on('error', (error) => {
        console.error(`[${new Date().toISOString()}] Health check failed:`, error.message);
    });

    req.on('timeout', () => {
        console.error(`[${new Date().toISOString()}] Health check timed out`);
        req.destroy();
    });

    req.end();
}

// Run immediately once
pingHealthEndpoint();

// Then run every minute
setInterval(pingHealthEndpoint, 60000);
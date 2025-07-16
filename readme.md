# WhatsApp Chatbot with Baileys on Render

A WhatsApp chatbot built with Baileys library that can be deployed on Render cloud platform.

## Features

- ✅ WhatsApp Web API integration using Baileys
- ✅ Multi-device support
- ✅ Persistent session storage
- ✅ Custom command system
- ✅ REST API endpoints
- ✅ Health monitoring
- ✅ Graceful shutdown
- ✅ Docker support
- ✅ Ready for Render deployment

## Commands

The bot supports the following commands:

- `!help` - Show available commands
- `!ping` - Check if bot is online
- `!echo <message>` - Echo your message
- `!time` - Get current time
- `!info` - Get bot information
- `!status` - Get bot status (owner only)

## Local Development

### Prerequisites

- Node.js 18+
- npm or yarn

### Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Set environment variables (optional):
   ```bash
   export OWNER_NUMBER=1234567890  # Your WhatsApp number
   export PORT=3000
   ```

4. Run the application:
   ```bash
   npm start
   ```

5. Open `http://localhost:3000` to check status
6. Visit `http://localhost:3000/qr` to get QR code for WhatsApp authentication

## Deployment on Render

### Option 1: Direct Git Deployment

1. **Create a new Web Service on Render**
   - Go to [Render Dashboard](https://dashboard.render.com/)
   - Click "New" → "Web Service"
   - Connect your GitHub repository

2. **Configure the service:**
   - **Name**: `whatsapp-chatbot`
   - **Region**: Choose closest to your users
   - **Branch**: `main`
   - **Root Directory**: Leave blank
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`

3. **Environment Variables:**
   - `OWNER_NUMBER`: Your WhatsApp number (without +)
   - `NODE_ENV`: `production`

4. **Deploy**: Click "Create Web Service"

### Option 2: Docker Deployment

1. **Create a new Web Service on Render**
2. **Configure for Docker:**
   - **Runtime**: `Docker`
   - **Dockerfile Path**: `./Dockerfile`

3. **Add environment variables** (same as above)

4. **Deploy**: Click "Create Web Service"

### Important Notes for Render Deployment

1. **Persistent Storage**: Render's free tier doesn't have persistent storage. Your bot will need to re-authenticate after each deployment. Consider upgrading to a paid plan for persistent disks.

2. **Environment Variables**: Set these in Render dashboard:
   ```
   OWNER_NUMBER=1234567890
   NODE_ENV=production
   ```

3. **Health Checks**: The app includes health check endpoints that Render can use to monitor your service.

4. **QR Code Authentication**: After deployment, visit `https://your-app.onrender.com/qr` to get the QR code for authentication.

## API Endpoints

- `GET /` - Service status
- `GET /qr` - Get QR code for authentication
- `GET /status` - Detailed bot status
- `GET /health` - Health check
- `POST /send-message` - Send message via API

### Send Message API

```bash
curl -X POST https://your-app.onrender.com/send-message \
  -H "Content-Type: application/json" \
  -d '{
    "number": "1234567890",
    "message": "Hello from API!"
  }'
```

## Authentication Process

1. Deploy the bot to Render
2. Visit the `/qr` endpoint to get the QR code
3. Scan the QR code with your WhatsApp mobile app
4. The bot will be authenticated and ready to use

## Monitoring

- Check logs in Render dashboard
- Monitor health at `/health` endpoint
- Get detailed status at `/status` endpoint

## Troubleshooting

### Common Issues

1. **Authentication Timeout**: 
   - QR codes expire after 20 seconds
   - Refresh the `/qr` endpoint to get a new code

2. **Connection Drops**:
   - The bot automatically reconnects
   - Check logs for connection issues

3. **Memory Issues**:
   - Render free tier has 512MB RAM limit
   - Consider upgrading for heavy usage

### Logs

Check Render logs for debugging:
- Connection status
- Message handling
- Error messages

## Security Considerations

1. **Owner Commands**: Some commands are restricted to the owner number
2. **Rate Limiting**: Consider implementing rate limiting for API endpoints
3. **Input Validation**: The bot validates all incoming messages
4. **Environment Variables**: Never commit sensitive data to the repository

## Customization

### Adding New Commands

Edit the `handleMessage` function in `index.js`:

```javascript
case 'yournewcommand':
    response = 'Your response here';
    break;
```

### Changing Bot Behavior

Modify the `botConfig` object to change:
- Bot name
- Welcome messages
- Command responses
- Prefix character

## Limitations

1. **Session Persistence**: Free tier restarts may require re-authentication
2. **Media Messages**: Current implementation handles text messages only
3. **Group Management**: Basic group support included
4. **Rate Limits**: WhatsApp has rate limits for automated messages

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - feel free to use and modify as needed.

## Support

For issues:
1. Check the logs in Render dashboard
2. Review WhatsApp terms of service
3. Ensure you're not violating any usage policies

Remember: This bot is for educational purposes. Always respect WhatsApp's terms of service and don't use it for spam or harassment.
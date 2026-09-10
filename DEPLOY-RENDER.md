# Deploy to Render - Step by Step Guide

## Prerequisites
- GitHub account
- Render account (https://render.com)

## Step 1: Push to GitHub
If not already done:
```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/lumi-auto-bid.git
git push -u origin main
```

## Step 2: Deploy Backend (API) to Render

1. Go to https://render.com and log in
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repository
4. Configure the service:
   - **Name**: `lumi-api`
   - **Region**: Oregon (or closest to you)
   - **Branch**: main
   - **Root Directory**: `server`
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free

5. Add Environment Variables (under "Environment"):
   - `PORT`: `10000`
   - `NODE_ENV`: `production`
   - `JWT_SECRET`: (click "Generate" to create a secure value)
   - `MINIMAX_API_KEY`: (your API key)
   - `MINIMAX_API_KEY_2`: (optional second key)
   - `DEEPSEEK_API_KEY`: (optional)
   - `GROQ_API_KEY`: (optional)

6. Click **"Create Web Service"**

7. Wait for deployment... (takes 2-3 minutes)

8. Note your backend URL: `https://lumi-api.onrender.com` (or whatever Render gives you)

## Step 3: Deploy Frontend (Client) to Render

1. Click **"New +"** → **"Static Site"**
2. Connect the same GitHub repository
3. Configure:
   - **Name**: `lumi-client`
   - **Region**: Oregon
   - **Branch**: main
   - **Root Directory**: `client`
   - **Build Command**: `npm install && npm run build`
   - **Publish Directory**: `dist`

4. Add Environment Variables:
   - `VITE_API_URL`: `https://lumi-api.onrender.com` (your backend URL from Step 2)

5. Under "Settings" → "Redirects/Rewrites":
   - Add a rewrite: Source `/*` → Destination `/index.html`

6. Click **"Create Static Site"**

## Step 4: Update Extension (Optional)

If using the Chrome extension, update the manifest to allow your new domain:
- Edit `extension/manifest.json`
- Add your frontend URL to `host_permissions`

## Important Notes

### Free Tier Limitations
- **Sleep after 15 minutes** of inactivity (backend wakes on first request)
- **500 MB bandwidth/month** limit
- **750 hours/month** across all free services

### For Production Use
Consider upgrading to a paid plan for:
- No sleep mode
- Better performance
- More bandwidth
- Custom domains

### Database
The app uses SQLite file-based database. On Render free tier:
- Data persists while service is active
- Data resets if the service sleeps (for free tier)
- Consider adding persistent disk storage for production

## Troubleshooting

### CORS Errors
Make sure the backend allows your frontend domain:
- In `server/index.js`, the CORS is already configured for localhost
- You may need to add your Render frontend URL to allowed origins

### API Returns 404
- Check if backend service is awake (may take 30 seconds after sleep)
- Verify the `VITE_API_URL` is set correctly in the frontend

### Database Not Persisting
- Free tier services can lose data after sleep
- Consider upgrading to paid tier with persistent disk

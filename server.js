require('dotenv').config();
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const app = express();
const port = process.env.PORT || 3001;
const axios = require('axios');

// Camera configuration from environment variables
const cameraConfig = {
  "360": {
    rtsp: process.env.CAM_360_URL,
    name: '360',
    ip: process.env.CAM_360_IP,
    port: process.env.CAM_360_PORT,
    user: process.env.CAM_360_USER,
    pass: process.env.CAM_360_PASS
  },
  "entrance": {
    rtsp: process.env.CAM_ENTRANCE_URL,
    name: 'entrance',
    ip: process.env.CAM_ENTRANCE_IP,
    port: process.env.CAM_ENTRANCE_PORT,
    user: process.env.CAM_ENTRANCE_USER,
    pass: process.env.CAM_ENTRANCE_PASS
  },
  "corridor-2": {
    rtsp: process.env.CAM_CORRIDOR2_URL,
    name: 'corridor-2',
    ip: process.env.CAM_CORRIDOR2_IP,
    port: process.env.CAM_CORRIDOR2_PORT,
    user: process.env.CAM_CORRIDOR2_USER,
    pass: process.env.CAM_CORRIDOR2_PASS
  },
  "corridor-1": {
    rtsp: process.env.CAM_CORRIDOR1_URL,
    name: 'corridor-1',
    ip: process.env.CAM_CORRIDOR1_IP,
    port: process.env.CAM_CORRIDOR1_PORT,
    user: process.env.CAM_CORRIDOR1_USER,
    pass: process.env.CAM_CORRIDOR1_PASS
  },
  "exit": {
    rtsp: process.env.CAM_EXIT_URL,
    name: 'exit',
    ip: process.env.CAM_EXIT_IP,
    port: process.env.CAM_EXIT_PORT,
    user: process.env.CAM_EXIT_USER,
    pass: process.env.CAM_EXIT_PASS
  }
};

const FFMPEG_PATH = process.env.FFMPEG_PATH;
const RECORDINGS_DIR = path.join(__dirname, 'recordings');
const SNAPSHOTS_DIR = path.join(__dirname, 'snapshots');
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
if (!fs.existsSync(SNAPSHOTS_DIR)) fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });

// State for motion detection and token management
const state = {
  lastMotionTime: {}, // cameraId: timestamp
  throttleTime: 60 * 1000, // 1 minute between triggers per camera
  tokens: {}, // cameraId: { token: string, expires: timestamp }
  tokenRefreshTime: 30 * 60 * 1000 // Refresh tokens every 30 minutes
};

// Token management for Reolink API
async function getToken(cameraId) {
  const camera = cameraConfig[cameraId];
  if (!camera) return null;
  
  const tokenInfo = state.tokens[cameraId];
  const now = Date.now();
  
  // Check if we have a valid token
  if (tokenInfo && tokenInfo.expires > now) {
    return tokenInfo.token;
  }
  
  try {
    const url = `http://${camera.ip}:${camera.port}/api.cgi?cmd=Login`;
    const body = [{
      cmd: "Login",
      param: {
        User: {
          userName: camera.user,
          password: camera.pass,
          Version: "0"
        }
      }
    }];
    
    const res = await axios.post(url, body, { timeout: 10000 });
    
    if (res.data && res.data[0] && res.data[0].code === 0 && res.data[0].value && res.data[0].value.Token) {
      const token = res.data[0].value.Token.name;
      const leaseTime = res.data[0].value.Token.leaseTime || 3600;
      
      state.tokens[cameraId] = {
        token: token,
        expires: now + (leaseTime * 1000) - (5 * 60 * 1000) // Refresh 5 minutes before expiry
      };
      
      console.log(`[${cameraId}] Token obtained successfully`);
      return token;
    } else {
      console.error(`[${cameraId}] Login failed:`, res.data);
      return null;
    }
  } catch (err) {
    console.error(`[${cameraId}] Error getting token:`, err.message);
    return null;
  }
}

// Helper to record video using ffmpeg
function recordVideo(cameraId, durationSeconds = 60) {
  const camera = cameraConfig[cameraId];
  if (!camera || !camera.rtsp) return;
  const now = Date.now();
  const dateDir = path.join(RECORDINGS_DIR, new Date(now).toISOString().split('T')[0]);
  if (!fs.existsSync(dateDir)) fs.mkdirSync(dateDir, { recursive: true });
  const filename = path.join(dateDir, `${cameraId}_motion_${now}.mp4`);
  const ffmpegArgs = [
    '-rtsp_transport', 'tcp',
    '-i', camera.rtsp,
    '-t', durationSeconds.toString(),
    '-c', 'copy',
    filename
  ];
  const ffmpeg = spawn(FFMPEG_PATH, ffmpegArgs);
  ffmpeg.stderr.on('data', data => {}); // Optionally log
  ffmpeg.on('close', code => {
    if (code === 0) {
      console.log(`[${cameraId}] Video recorded: ${filename}`);
    } else {
      console.error(`[${cameraId}] ffmpeg exited with code ${code}`);
    }
  });
}

// Helper to take snapshot using ffmpeg
function takeSnapshot(cameraId) {
  const camera = cameraConfig[cameraId];
  if (!camera || !camera.rtsp) return;
  const now = Date.now();
  const dateDir = path.join(SNAPSHOTS_DIR, new Date(now).toISOString().split('T')[0]);
  if (!fs.existsSync(dateDir)) fs.mkdirSync(dateDir, { recursive: true });
  const filename = path.join(dateDir, `${cameraId}_${now}.jpg`);
  const ffmpegArgs = [
    '-rtsp_transport', 'tcp',
    '-i', camera.rtsp,
    '-frames:v', '1',
    '-q:v', '2',
    filename
  ];
  const ffmpeg = spawn(FFMPEG_PATH, ffmpegArgs);
  ffmpeg.stderr.on('data', data => {}); // Optionally log
  ffmpeg.on('close', code => {
    if (code === 0) {
      console.log(`[${cameraId}] Snapshot taken: ${filename}`);
    } else {
      console.error(`[${cameraId}] ffmpeg snapshot exited with code ${code}`);
    }
  });
}

// Comprehensive activity detection using Reolink API
async function detectActivity(cameraId) {
  const camera = cameraConfig[cameraId];
  if (!camera || !camera.ip || !camera.port || !camera.user || !camera.pass) return false;
  
  try {
    const token = await getToken(cameraId);
    if (!token) return false;
    
    const results = {
      motion: await checkMotionDetection(camera, token),
      ai: await checkAIDetection(camera, token),
      alarm: await checkAlarmState(camera, token)
    };
    
    const anyActivity = results.motion || results.ai || results.alarm;
    
    if (anyActivity) {
      console.log(`[${cameraId}] Activity detected:`, {
        motion: results.motion,
        ai: results.ai,
        alarm: results.alarm,
        timestamp: new Date().toISOString()
      });
    }
    
    return anyActivity;
  } catch (err) {
    console.error(`[${cameraId}] Error in activity detection:`, err.message);
    return false;
  }
}

// Check motion detection state
async function checkMotionDetection(camera, token) {
  try {
    const url = `http://${camera.ip}:${camera.port}/api.cgi?cmd=GetMdState&token=${token}`;
    const body = [{
      cmd: "GetMdState",
      action: 0,
      param: { channel: 0 }
    }];
    const res = await axios.post(url, body, { timeout: 5000 });
    console.log(`[${camera.name}] Motion detection response:`, JSON.stringify(res.data, null, 2));
    return res.data && res.data[0] && res.data[0].code === 0 && res.data[0].value && res.data[0].value.MdState && res.data[0].value.MdState.state === 1;
  } catch (err) {
    console.error(`Motion detection check failed:`, err.message);
    return false;
  }
}

// Check AI detection (person, vehicle, pet)
async function checkAIDetection(camera, token) {
  try {
    const url = `http://${camera.ip}:${camera.port}/api.cgi?cmd=GetAiState&token=${token}`;
    const body = [{
      cmd: "GetAiState",
      action: 0,
      param: { channel: 0 }
    }];
    const res = await axios.post(url, body, { timeout: 5000 });
    console.log(`[${camera.name}] AI detection response:`, JSON.stringify(res.data, null, 2));
    if (res.data && res.data[0] && res.data[0].code === 0 && res.data[0].value && res.data[0].value.AiState) {
      const aiState = res.data[0].value.AiState;
      return (aiState.person && aiState.person.state === 1) ||
             (aiState.vehicle && aiState.vehicle.state === 1) ||
             (aiState.pet && aiState.pet.state === 1);
    }
    return false;
  } catch (err) {
    console.error(`AI detection check failed:`, err.message);
    return false;
  }
}

// Check alarm state (general activity)
async function checkAlarmState(camera, token) {
  try {
    const url = `http://${camera.ip}:${camera.port}/api.cgi?cmd=GetAlarmState&token=${token}`;
    const body = [{
      cmd: "GetAlarmState",
      action: 0,
      param: { channel: 0 }
    }];
    const res = await axios.post(url, body, { timeout: 5000 });
    console.log(`[${camera.name}] Alarm state response:`, JSON.stringify(res.data, null, 2));
    if (res.data && res.data[0] && res.data[0].code === 0 && res.data[0].value && res.data[0].value.AlarmState) {
      const alarmState = res.data[0].value.AlarmState;
      return alarmState.state === 1 || alarmState.motion === 1 || alarmState.sound === 1;
    }
    return false;
  } catch (err) {
    console.error(`Alarm state check failed:`, err.message);
    return false;
  }
}

// Main activity detection loop
setInterval(async () => {
  for (const cameraId of Object.keys(cameraConfig)) {
    if (!cameraConfig[cameraId].rtsp) continue;
    const activity = await detectActivity(cameraId);
    if (activity) {
      const last = state.lastMotionTime[cameraId] || 0;
      if (Date.now() - last > state.throttleTime) {
        state.lastMotionTime[cameraId] = Date.now();
        console.log(`[${cameraId}] Triggering recording and snapshot due to activity`);
        takeSnapshot(cameraId);
        recordVideo(cameraId, 60); // 60 seconds
      }
    }
  }
}, 2000); // Poll every 2 seconds

// --- API Endpoints ---

// Schedule random snapshots for all cameras
function scheduleRandomSnapshot() {
  const minDelayMs = 1 * 60 * 60 * 1000; // 1 hour
  const maxDelayMs = 2.5 * 60 * 60 * 1000; // 2.5 hours
  const randomDelay = Math.random() * (maxDelayMs - minDelayMs) + minDelayMs;

  setTimeout(() => {
    console.log('Triggering random snapshots for all cameras.');
    for (const cameraId of Object.keys(cameraConfig)) {
      if (cameraConfig[cameraId].rtsp) {
        takeSnapshot(cameraId);
      }
    }
    scheduleRandomSnapshot(); // Schedule the next random snapshot
  }, randomDelay);
  console.log(`Next random snapshot scheduled in ${Math.round(randomDelay / (1000 * 60 * 60))} hours.`);
}

scheduleRandomSnapshot(); // Initiate random snapshots on startup

// Health endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    uptime: process.uptime(),
    date: new Date().toISOString(),
    cameras: Object.keys(cameraConfig),
    activeTokens: Object.keys(state.tokens).length
  });
});

// Manual snapshot endpoint
app.post('/snapshot/:cameraId', (req, res) => {
  const cameraId = req.params.cameraId;
  if (!cameraConfig[cameraId] || !cameraConfig[cameraId].rtsp) {
    return res.status(404).json({ success: false, error: 'Camera not found' });
  }
  takeSnapshot(cameraId);
  res.json({ success: true, message: `Snapshot triggered for ${cameraId}` });
});

// Debug endpoint to check camera API responses
app.get('/debug/:cameraId', async (req, res) => {
  const cameraId = req.params.cameraId;
  if (!cameraConfig[cameraId]) {
    return res.status(404).json({ success: false, error: 'Camera not found' });
  }
  
  try {
    const camera = cameraConfig[cameraId];
    const token = await getToken(cameraId);
    
    if (!token) {
      return res.status(500).json({ success: false, error: 'Failed to get token' });
    }
    
    // Get all detection states
    const motionUrl = `http://${camera.ip}:${camera.port}/api.cgi?cmd=GetMdState&token=${token}`;
    const aiUrl = `http://${camera.ip}:${camera.port}/api.cgi?cmd=GetAiState&token=${token}`;
    const alarmUrl = `http://${camera.ip}:${camera.port}/api.cgi?cmd=GetAlarmState&token=${token}`;
    
    const [motionRes, aiRes, alarmRes] = await Promise.all([
      axios.post(motionUrl, [{ cmd: "GetMdState", action: 0, param: { channel: 0 } }], { timeout: 5000 }),
      axios.post(aiUrl, [{ cmd: "GetAiState", action: 0, param: { channel: 0 } }], { timeout: 5000 }),
      axios.post(alarmUrl, [{ cmd: "GetAlarmState", action: 0, param: { channel: 0 } }], { timeout: 5000 })
    ]);
    
    res.json({
      success: true,
      cameraId,
      timestamp: new Date().toISOString(),
      token: token.substring(0, 8) + '...',
      responses: {
        motion: motionRes.data,
        ai: aiRes.data,
        alarm: alarmRes.data
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Check camera settings endpoint
app.get('/camera-settings/:cameraId', async (req, res) => {
  const cameraId = req.params.cameraId;
  if (!cameraConfig[cameraId]) {
    return res.status(404).json({ success: false, error: 'Camera not found' });
  }
  
  try {
    const camera = cameraConfig[cameraId];
    const token = await getToken(cameraId);
    
    if (!token) {
      return res.status(500).json({ success: false, error: 'Failed to get token' });
    }
    
    // Get motion detection settings
    const mdSettingsUrl = `http://${camera.ip}:${camera.port}/api.cgi?cmd=GetMdState&token=${token}`;
    const mdSettingsRes = await axios.post(mdSettingsUrl, [{ 
      cmd: "GetMdState", 
      action: 1, // Get settings
      param: { channel: 0 } 
    }], { timeout: 5000 });
    
    res.json({
      success: true,
      cameraId,
      timestamp: new Date().toISOString(),
      motionDetectionSettings: mdSettingsRes.data
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// List all recordings
app.get('/recordings', (req, res) => {
  const recordings = [];
  if (fs.existsSync(RECORDINGS_DIR)) {
    const dateDirs = fs.readdirSync(RECORDINGS_DIR);
    dateDirs.forEach(dateDir => {
      const datePath = path.join(RECORDINGS_DIR, dateDir);
      if (fs.statSync(datePath).isDirectory()) {
        const files = fs.readdirSync(datePath);
        files.forEach(file => {
          if (file.endsWith('.mp4')) {
            recordings.push({
              cameraId: file.split('_')[0],
              date: dateDir,
              file: file,
              path: path.join(dateDir, file)
            });
          }
        });
      }
    });
  }
  recordings.sort((a, b) => b.file.localeCompare(a.file));
  res.json({ success: true, recordings });
});

app.listen(port, '0.0.0.0', () => console.log(`Server listening on http://0.0.0.0:${port}`));
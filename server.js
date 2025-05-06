require('dotenv').config();
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const basicAuth = require('express-basic-auth');
const schedule = require('node-schedule');
const sharp = require('sharp');
const bodyParser = require('body-parser');
const app = express();
const port = process.env.PORT || 3001;

// Parse JSON request bodies
app.use(bodyParser.json());

// Configuration
const config = {
  recordingsDir: path.join(__dirname, 'recordings'),
  snapshotsDir: path.join(__dirname, 'snapshots'),
  motionDetectionDir: path.join(__dirname, 'motion_detection'),
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  streamCacheTime: 30000,
  recordingRetries: 3,
  auth: {
    users: { [process.env.ADMIN_USER]: process.env.ADMIN_PASS }
  },
  motionDetection: {
    interval: 1000,
    differenceThreshold: 5,
    minPixelDifference: 100,
    throttleTime: 15 * 60 * 1000,
    width: 320,
    height: 180,
    sampleRate: 2,
  }
};

// Camera configuration from environment variables
const cameraConfig = {
  "360": process.env.CAM_360_URL,
  "entrance": process.env.CAM_ENTRANCE_URL,
  "corridor-2": process.env.CAM_CORRIDOR2_URL,
  "corridor-1": process.env.CAM_CORRIDOR1_URL,
  "exit": process.env.CAM_EXIT_URL
};

// State management
const state = {
  activeRecordings: new Map(),
  snapshotIntervals: new Map(),
  activeStreams: new Map(),
  ffmpegLogStream: fs.createWriteStream(path.join(__dirname, 'ffmpeg.log'), { flags: 'a' }),
  motionDetection: {
    lastFrame: null,
    lastFramePath: null,
    lastMotionTime: 0,
    consecutiveMotionFrames: 0,
    motionThreshold: 3,
    isProcessing: false,
    motionDetectionActive: true
  }
};

// Setup directories
[config.recordingsDir, config.snapshotsDir, config.motionDetectionDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Helper functions
const getDatePath = (baseDir) => {
  const dateDir = path.join(baseDir, new Date().toISOString().split('T')[0]);
  if (!fs.existsSync(dateDir)) fs.mkdirSync(dateDir, { recursive: true });
  return dateDir;
};

const safeCameraId = (cameraId) => {
  return Object.keys(cameraConfig).includes(cameraId) ? cameraId : '360';
};

const safeDeleteFile = (filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlink(filePath, (err) => {
      if (err) console.error(`Error deleting file ${filePath}:`, err);
    });
  }
};

const cleanupMotionFiles = () => {
  const debugDir = path.join(config.motionDetectionDir, 'debug');
  if (fs.existsSync(debugDir)) {
    fs.readdir(debugDir, (err, files) => {
      if (err) return;
      const now = Date.now();
      files.forEach(file => {
        const filePath = path.join(debugDir, file);
        fs.stat(filePath, (err, stats) => {
          if (!err && now - stats.mtimeMs > 3 * 24 * 60 * 60 * 1000) {
            safeDeleteFile(filePath);
          }
        });
      });
    });
  }
};

// FFmpeg process management
class FFmpegManager {
  static startMotionRecording(cameraId) {
    if (state.activeRecordings.has(cameraId)) {
      const existingProcess = state.activeRecordings.get(cameraId);
      if (existingProcess && existingProcess.kill) {
        existingProcess.kill('SIGTERM');
      }
      state.activeRecordings.delete(cameraId);
    }
    
    const outputPath = path.join(getDatePath(config.recordingsDir), 
      `${cameraId}_motion_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp4`);
    
    const args = [
      '-rtsp_transport', 'tcp',
      '-i', cameraConfig[cameraId],
      '-t', '300',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-crf', '23',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov'
    ];

    if (cameraId === "360") {
      args.push(
        '-vf', 'scale=896:512:force_original_aspect_ratio=decrease,pad=896:512:(ow-iw)/2:(oh-ih)/2',
        '-b:v', '256k',
        '-bufsize', '512k',
        '-r', '10',
        '-g', '40'
      );
    } else {
      args.push(
        '-vf', 'scale=640:480:force_original_aspect_ratio=decrease',
        '-b:v', '256k',
        '-bufsize', '512k',
        '-r', '10'
      );
    }

    args.push(outputPath);

    try {
      const ffmpeg = spawn(config.ffmpegPath, args);
      state.activeRecordings.set(cameraId, ffmpeg);
      ffmpeg.stderr.pipe(state.ffmpegLogStream);
      
      ffmpeg.on('close', code => {
        state.activeRecordings.delete(cameraId);
        if (code !== 0) {
          console.error(`Motion recording failed for ${cameraId} with code ${code}`);
        }
      });
      
      ffmpeg.on('error', err => {
        console.error(`FFmpeg error for ${cameraId}:`, err);
        state.activeRecordings.delete(cameraId);
      });
      
      return ffmpeg;
    } catch (error) {
      console.error(`Failed to start recording for ${cameraId}:`, error);
      return null;
    }
  }

  static createStream(cameraId) {
    try {
      const args = [
        '-rtsp_transport', 'tcp',
        '-i', cameraConfig[cameraId],
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-f', 'mpegts',
        '-'
      ];
      const process = spawn(config.ffmpegPath, args);
      
      process.on('error', err => {
        console.error(`Stream process error for ${cameraId}:`, err);
        if (state.activeStreams.has(cameraId)) {
          state.activeStreams.delete(cameraId);
        }
      });
      
      return process;
    } catch (error) {
      console.error(`Failed to create stream for ${cameraId}:`, error);
      return null;
    }
  }
}

// Snapshot system
function scheduleRandomSnapshots() {
  Object.keys(cameraConfig).forEach(cameraId => {
    const scheduleNext = () => {
      let minDelay, maxDelay;
      if (["360", "corridor-1", "corridor-2"].includes(cameraId)) {
        minDelay = 1 * 60 * 60 * 1000;
        maxDelay = 3 * 60 * 60 * 1000;
      } else {
        minDelay = 3 * 60 * 60 * 1000;
        maxDelay = 5 * 60 * 60 * 1000;
      }
      const delay = minDelay + Math.random() * (maxDelay - minDelay);
      const timer = setTimeout(() => {
        captureSnapshot(cameraId)
          .catch(err => console.error(`Snapshot error for ${cameraId}:`, err))
          .finally(scheduleNext);
      }, delay);
      state.snapshotIntervals.set(cameraId, timer);
    };
    scheduleNext();
  });
}

function clearAllSnapshots() {
  state.snapshotIntervals.forEach(timer => clearTimeout(timer));
  state.snapshotIntervals.clear();
}

async function captureSnapshot(cameraId) {
  const outputPath = path.join(getDatePath(config.snapshotsDir), `${cameraId}_${Date.now()}.jpg`);
  return new Promise((resolve, reject) => {
    try {
      const ffmpeg = spawn(config.ffmpegPath, [
        '-rtsp_transport', 'tcp',
        '-i', cameraConfig[cameraId],
        '-frames:v', '1',
        '-q:v', '2',
        outputPath
      ]);
      
      const timeout = setTimeout(() => {
        ffmpeg.kill();
        reject(new Error(`Snapshot timeout for ${cameraId}`));
      }, 30000);
      
      ffmpeg.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve(outputPath);
        } else {
          reject(new Error(`Snapshot failed for ${cameraId} with code ${code}`));
        }
      });
      
      ffmpeg.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    } catch (error) {
      reject(error);
    }
  });
}

const cleanupMotionDetectionFrames = () => {
  fs.readdir(config.motionDetectionDir, (err, files) => {
    if (err) return;
    
    files.forEach(file => {
      const filePath = path.join(config.motionDetectionDir, file);
      if (file === 'debug' || !file.startsWith('frame_')) return;
      
      fs.stat(filePath, (err, stats) => {
        if (!err) {
          const fileDate = new Date(stats.mtime).toISOString().split('T')[0];
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          const yesterdayStr = yesterday.toISOString().split('T')[0];
          
          if (fileDate <= yesterdayStr) {
            safeDeleteFile(filePath);
          }
        }
      });
    });
  });
  
  const debugDir = path.join(config.motionDetectionDir, 'debug');
  if (fs.existsSync(debugDir)) {
    fs.readdir(debugDir, (err, files) => {
      if (err) return;
      
      files.forEach(file => {
        const filePath = path.join(debugDir, file);
        fs.stat(filePath, (err, stats) => {
          if (!err) {
            const fileDate = new Date(stats.mtime).toISOString().split('T')[0];
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const yesterdayStr = yesterday.toISOString().split('T')[0];
            
            if (fileDate <= yesterdayStr) {
              safeDeleteFile(filePath);
            }
          }
        });
      });
    });
  }
};

// Start snapshot scheduling
scheduleRandomSnapshots();

// Daily maintenance
schedule.scheduleJob('0 0 * * *', () => {
  clearAllSnapshots();
  scheduleRandomSnapshots();
  cleanupMotionFiles();
  cleanupMotionDetectionFrames();
});

// Motion Detection Functions
async function captureMotionDetectionFrame() {
  const cameraId = "360";
  const outputPath = path.join(config.motionDetectionDir, `frame_${Date.now()}.jpg`);
  
  return new Promise((resolve, reject) => {
    try {
      const ffmpeg = spawn(config.ffmpegPath, [
        '-rtsp_transport', 'tcp',
        '-i', cameraConfig[cameraId],
        '-frames:v', '1',
        '-q:v', '5',
        '-vf', `scale=${config.motionDetection.width}:${config.motionDetection.height}`,
        outputPath
      ]);
      
      const timeout = setTimeout(() => {
        ffmpeg.kill();
        reject(new Error('Frame capture timeout'));
      }, 10000);
      
      ffmpeg.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve(outputPath);
        } else {
          reject(new Error(`Frame capture failed with code ${code}`));
        }
      });
      
      ffmpeg.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function analyzeImageData(imagePath) {
  try {
    const imageBuffer = await sharp(imagePath)
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    return {
      data: imageBuffer.data,
      info: imageBuffer.info
    };
  } catch (error) {
    console.error("Error analyzing image:", error);
    throw error;
  }
}

async function compareFrames(currentFramePath, previousFrameData) {
  if (!previousFrameData) return { motion: false, difference: 0 };
  
  try {
    const currentFrame = await analyzeImageData(currentFramePath);
    const { data: currentData } = currentFrame;
    const { data: previousData } = previousFrameData;
    
    if (currentData.length !== previousData.length) {
      return { motion: false, difference: 0, currentFrame };
    }
    
    let diffPixels = 0;
    const sampleRate = config.motionDetection.sampleRate;
    const totalPixels = Math.floor(currentData.length / (sampleRate * 3));
    const length = currentData.length;
    const step = 3 * sampleRate;
    
    for (let i = 0; i < length; i += step) {
      const diffR = Math.abs(currentData[i] - previousData[i]);
      const diffG = Math.abs(currentData[i + 1] - previousData[i + 1]);
      const diffB = Math.abs(currentData[i + 2] - previousData[i + 2]);
      
      if (diffR > 30 || diffG > 30 || diffB > 30) {
        diffPixels++;
      }
    }
    
    const percentageDiff = (diffPixels / totalPixels) * 100;
    const motion = percentageDiff > config.motionDetection.differenceThreshold && 
                  diffPixels > config.motionDetection.minPixelDifference;
    
    if (motion) {
      const debugDir = path.join(config.motionDetectionDir, 'debug');
      if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
      
      fs.copyFile(currentFramePath, path.join(debugDir, `motion_${Date.now()}_${percentageDiff.toFixed(2)}.jpg`), (err) => {
        if (err) console.error("Error copying debug frame:", err);
      });
    }
    
    return { 
      motion, 
      difference: percentageDiff, 
      diffPixels,
      totalPixels,
      currentFrame 
    };
  } catch (error) {
    console.error("Error comparing frames:", error);
    return { motion: false, difference: 0 };
  }
}

// Main motion detection function - Modified to record all cameras
async function detectMotion() {
  if (state.motionDetection.isProcessing) return false;
  
  state.motionDetection.isProcessing = true;
  const currentTime = Date.now();
  
  try {
    if (currentTime - state.motionDetection.lastMotionTime < config.motionDetection.throttleTime) {
      state.motionDetection.isProcessing = false;
      return false;
    }
    
    if (state.motionDetection.lastFramePath) {
      safeDeleteFile(state.motionDetection.lastFramePath);
      state.motionDetection.lastFramePath = null;
    }
    
    const framePath = await captureMotionDetectionFrame();
    const result = await compareFrames(framePath, state.motionDetection.lastFrame);
    
    state.motionDetection.lastFrame = result.currentFrame;
    state.motionDetection.lastFramePath = framePath;
    
    if (result.motion) {
      state.motionDetection.consecutiveMotionFrames++;
      console.log(`Motion detected: ${result.difference.toFixed(2)}% (${result.diffPixels}/${result.totalPixels} pixels)`);
      
      if (state.motionDetection.consecutiveMotionFrames >= state.motionDetection.motionThreshold) {
        console.log("Motion confirmed! Triggering recordings for ALL cameras...");
        
        state.motionDetection.consecutiveMotionFrames = 0;
        state.motionDetection.lastMotionTime = currentTime;
        
        // Trigger recording for ALL cameras with slight delay
        const cameraIds = Object.keys(cameraConfig);
        cameraIds.forEach((cameraId, index) => {
          setTimeout(() => {
            console.log(`Starting motion recording for ${cameraId}`);
            FFmpegManager.startMotionRecording(cameraId);
          }, index * 500); // Stagger recordings by 500ms to reduce load
        });
        
        state.motionDetection.isProcessing = false;
        return true;
      }
    } else {
      state.motionDetection.consecutiveMotionFrames = 0;
    }
    
    state.motionDetection.isProcessing = false;
    return result.motion;
  } catch (error) {
    console.error("Motion detection error:", error);
    state.motionDetection.isProcessing = false;
    return false;
  }
}

function startMotionDetectionLoop() {
  const motionInterval = setInterval(async () => {
    if (!state.motionDetection.motionDetectionActive) return;
    
    try {
      await detectMotion();
    } catch (error) {
      console.error("Error in motion detection loop:", error);
    }
  }, config.motionDetection.interval);
  
  process.on('SIGTERM', () => {
    clearInterval(motionInterval);
  });
}

// API Endpoints
app.get("/stream", (req, res) => {
  const cameraId = safeCameraId(req.query.camera || "360");
  
  let ffmpegArgs = [
    "-rtsp_transport", "tcp",
    "-i", cameraConfig[cameraId],
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-tune", "zerolatency",
    "-crf", "23",
    "-f", "mp4",
    "-movflags", "frag_keyframe+empty_moov",
    "-vf", "scale=640:360",
    "-b:v", "256k",
    "-bufsize", "512k",
    "-threads", "2",
    "-"
  ];

  if (cameraId === "360") {
    ffmpegArgs = [
      "-rtsp_transport", "tcp",
      "-i", cameraConfig[cameraId],
      "-fflags", "nobuffer",
      "-flags", "low_delay",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-tune", "zerolatency",
      "-crf", "20",
      "-vf", "scale=896:512:force_original_aspect_ratio=decrease",
      "-b:v", "256k",
      "-bufsize", "512k",
      "-r", "10",
      "-g", "40",
      "-f", "mp4",
      "-movflags", "frag_keyframe+empty_moov",
      "-threads", "8",
      "-"
    ];
  }
  
  try {
    const ffmpeg = spawn(config.ffmpegPath, ffmpegArgs);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Transfer-Encoding", "chunked");
    
    const streamId = `${cameraId}_${Date.now()}`;
    state.activeStreams.set(streamId, ffmpeg);
    
    ffmpeg.stdout.pipe(res);

    ffmpeg.stderr.on("data", (err) => {
      console.error(`FFmpeg stream error for ${cameraId}:`, err.toString());
    });

    ffmpeg.on("error", (err) => {
      console.error(`Stream process error for ${cameraId}:`, err.toString());
      state.activeStreams.delete(streamId);
      res.status(500).end();
    });

    req.on("close", () => {
      ffmpeg.kill();
      state.activeStreams.delete(streamId);
    });
    
    const timeout = setTimeout(() => {
      if (state.activeStreams.has(streamId)) {
        ffmpeg.kill();
        state.activeStreams.delete(streamId);
      }
    }, 60 * 60 * 1000);
    
    req.on("close", () => {
      clearTimeout(timeout);
    });
  } catch (error) {
    console.error(`Error creating stream for ${cameraId}:`, error);
    res.status(500).send("Error creating stream");
  }
});

// Protected endpoints
app.use('/control', basicAuth(config.auth));

app.post('/control/motion', (req, res) => {
  Object.keys(cameraConfig).forEach(cameraId => {
    FFmpegManager.startMotionRecording(cameraId);
  });
  res.json({ success: true, message: "Motion recordings started for all cameras" });
});

app.post('/control/test-motion', async (req, res) => {
  try {
    const result = await detectMotion();
    res.json({ 
      success: true, 
      motionDetected: result,
      consecutiveFrames: state.motionDetection.consecutiveMotionFrames,
      lastMotionTime: new Date(state.motionDetection.lastMotionTime).toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/control/motion-detection', (req, res) => {
  const { active } = req.body;
  
  if (typeof active === 'boolean') {
    state.motionDetection.motionDetectionActive = active;
    res.json({ 
      success: true, 
      message: `Motion detection system ${active ? 'enabled' : 'disabled'}`,
      active: state.motionDetection.motionDetectionActive
    });
  } else {
    res.status(400).json({ 
      success: false, 
      error: "Invalid request: 'active' must be a boolean value" 
    });
  }
});

app.get('/control/motion-settings', (req, res) => {
  res.json({
    settings: config.motionDetection,
    state: {
      active: state.motionDetection.motionDetectionActive,
      lastMotionTime: new Date(state.motionDetection.lastMotionTime).toISOString(),
      consecutiveMotionFrames: state.motionDetection.consecutiveMotionFrames,
      isProcessing: state.motionDetection.isProcessing
    }
  });
});

app.post('/control/motion-settings', (req, res) => {
  try {
    const newSettings = req.body;
    Object.keys(newSettings).forEach(key => {
      if (config.motionDetection.hasOwnProperty(key)) {
        config.motionDetection[key] = newSettings[key];
      }
    });
    
    res.json({ 
      success: true, 
      message: "Motion detection settings updated",
      settings: config.motionDetection
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/control/recordings', (req, res) => {
  try {
    const recordings = [];
    const dateDirs = fs.readdirSync(config.recordingsDir);
    
    dateDirs.forEach(dateDir => {
      const datePath = path.join(config.recordingsDir, dateDir);
      if (fs.statSync(datePath).isDirectory()) {
        const files = fs.readdirSync(datePath);
        
        files.forEach(file => {
          const match = file.match(/^(.+)_motion_(\d+)\.mp4$/);
          if (match) {
            const [_, cameraId, timestamp] = match;
            recordings.push({
              cameraId,
              date: dateDir,
              timestamp: parseInt(timestamp),
              datetime: new Date(parseInt(timestamp)).toISOString(),
              file: file,
              path: path.join(dateDir, file)
            });
          }
        });
      }
    });
    
    recordings.sort((a, b) => b.timestamp - a.timestamp);
    res.json({ success: true, recordings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    uptime: process.uptime(),
    date: new Date().toISOString(),
    activeStreams: state.activeStreams.size,
    activeRecordings: state.activeRecordings.size,
    motionDetection: {
      active: state.motionDetection.motionDetectionActive,
      lastMotionTime: new Date(state.motionDetection.lastMotionTime).toISOString(),
      consecutiveMotionFrames: state.motionDetection.consecutiveMotionFrames,
      isProcessing: state.motionDetection.isProcessing
    }
  });
});

app.get('/control/system', (req, res) => {
  const memoryUsage = process.memoryUsage();
  res.json({
    success: true,
    system: {
      memory: {
        rss: Math.round(memoryUsage.rss / 1024 / 1024) + ' MB',
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + ' MB',
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + ' MB',
        external: Math.round(memoryUsage.external / 1024 / 1024) + ' MB'
      },
      uptime: Math.round(process.uptime()) + ' seconds',
      activeStreams: Array.from(state.activeStreams.keys()),
      activeRecordings: Array.from(state.activeRecordings.keys())
    }
  });
});

// Start the motion detection loop
startMotionDetectionLoop();

// Cleanup on exit
process.on('SIGTERM', () => {
  clearAllSnapshots();
  state.ffmpegLogStream.end();
  process.exit(0);
});

app.listen(port, () => console.log(`Server running on port ${port}`));
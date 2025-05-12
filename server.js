require('dotenv').config(); 
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const basicAuth = require('express-basic-auth');
const schedule = require('node-schedule');
const sharp = require('sharp');
const bodyParser = require('body-parser'); // Added for parsing JSON request bodies
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
  streamCacheTime: 30000, // 30 seconds stream caching
  recordingRetries: 3,
  auth: {
    users: { [process.env.ADMIN_USER]: process.env.ADMIN_PASS }
  },
  // Motion detection configuration
  motionDetection: {
    interval: 1000, // Check every 1 second
    differenceThreshold: 5, // Percentage difference to trigger (5%)
    minPixelDifference: 100, // Minimum number of pixels that need to change
    throttleTime: 15 * 60 * 1000, // 15 minutes between motion triggers
    width: 320, // Width to resize frames to for motion detection
    height: 180, // Height to resize frames to for motion detection
    sampleRate: 2, // Sample every nth pixel for faster processing
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

// State management - optimized to prevent memory leaks
const state = {
  activeRecordings: new Map(),
  snapshotIntervals: new Map(),
  activeStreams: new Map(),
  ffmpegLogStream: fs.createWriteStream(path.join(__dirname, 'ffmpeg.log'), { flags: 'a' }),
  // Motion detection state
  motionDetection: {
    lastFrame: null,
    lastFramePath: null,
    lastMotionTime: 0,
    consecutiveMotionFrames: 0,
    motionThreshold: 3, // Number of consecutive frames with motion before triggering
    isProcessing: false, // Flag to prevent concurrent motion detection operations
    motionDetectionActive: true // Flag to enable/disable motion detection system
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

// Helper for safe file deletion
const safeDeleteFile = (filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlink(filePath, (err) => {
      if (err) console.error(`Error deleting file ${filePath}:`, err);
    });
  }
};

// Cleanup old motion detection frames - run periodically
const cleanupMotionFiles = () => {
  const debugDir = path.join(config.motionDetectionDir, 'debug');
  if (fs.existsSync(debugDir)) {
    fs.readdir(debugDir, (err, files) => {
      if (err) {
        console.error('Error reading debug directory:', err);
        return;
      }
      
      const now = Date.now();
      files.forEach(file => {
        const filePath = path.join(debugDir, file);
        fs.stat(filePath, (err, stats) => {
          if (err) {
            console.error(`Error getting stats for ${filePath}:`, err);
            return;
          }
          
          // Delete files older than 3 days
          if (now - stats.mtimeMs > 3 * 24 * 60 * 60 * 1000) {
            safeDeleteFile(filePath);
          }
        });
      });
    });
  }
};

// FFmpeg process management - optimized to prevent resource leaks
class FFmpegManager {
  // Motion-triggered recording for any camera
  static startMotionRecording(cameraId) {
    // Check if we already have an active recording for this camera
    if (state.activeRecordings.has(cameraId)) {
      console.log(`Recording already in progress for ${cameraId}, skipping`);
      const existingProcess = state.activeRecordings.get(cameraId);
      // Kill it gracefully
      if (existingProcess && existingProcess.kill) {
        existingProcess.kill('SIGTERM');
      }
      // Remove from active recordings
      state.activeRecordings.delete(cameraId);
    }
    
    // Record a 5-minute clip (300 seconds) when motion is detected
    // Use a more unique filename with random suffix
    const outputPath = path.join(getDatePath(config.recordingsDir), 
      `${cameraId}_motion_${Date.now()}_${Math.floor(Math.random() * 1000)}.mp4`);
    
    const args = [
      '-rtsp_transport', 'tcp',
      '-i', cameraConfig[cameraId],
      '-t', '300', // record for 5 minutes
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-crf', '23',
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov'
    ];

    // Special processing for camera "360" (or any camera if needed)
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
      
      // Store the process to prevent duplicates and manage cleanup
      state.activeRecordings.set(cameraId, ffmpeg);
      
      ffmpeg.stderr.pipe(state.ffmpegLogStream);
      
      ffmpeg.on('close', code => {
        // Cleanup and remove from active recordings
        state.activeRecordings.delete(cameraId);
        
        if (code !== 0) {
          console.error(`Motion recording failed for ${cameraId} with code ${code}`);
        } else {
          console.log(`Motion recording completed for ${cameraId}`);
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
      
      // Setup error handling
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

// Snapshot system - optimized to prevent resource leaks
function scheduleRandomSnapshots() {
  Object.keys(cameraConfig).forEach(cameraId => {
    const scheduleNext = () => {
      let minDelay, maxDelay;
      // Priority cameras: "360", "corridor-1", "corridor-2" get snapshots every 1 to 3 hours
      if (["360", "corridor-1", "corridor-2"].includes(cameraId)) {
        minDelay = 1 * 60 * 60 * 1000;
        maxDelay = 3 * 60 * 60 * 1000;
      } else {
        // Lower priority cameras: "entrance" and "exit" get snapshots every 3 to 5 hours
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
      
      // Set timeout to kill the process if it takes too long
      const timeout = setTimeout(() => {
        ffmpeg.kill();
        reject(new Error(`Snapshot timeout for ${cameraId}`));
      }, 30000); // 30 seconds timeout
      
      ffmpeg.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          console.log(`Snapshot captured for ${cameraId}`);
          resolve(outputPath);
        } else {
          console.error(`Snapshot failed for ${cameraId} with code ${code}`);
          reject(new Error(`Snapshot failed for ${cameraId} with code ${code}`));
        }
      });
      
      ffmpeg.on('error', (err) => {
        clearTimeout(timeout);
        console.error(`Snapshot process error for ${cameraId}:`, err);
        reject(err);
      });
    } catch (error) {
      reject(error);
    }
  });
}
// Add this function to clean up old motion detection frames
const cleanupMotionDetectionFrames = () => {
  console.log('Running daily cleanup of motion detection frames...');
  
  // Get the current date and the previous date
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  
  // Format previous date as YYYY-MM-DD for comparison
  const yesterdayStr = yesterday.toISOString().split('T')[0];
  
  // Clean up main motion detection frames
  fs.readdir(config.motionDetectionDir, (err, files) => {
    if (err) {
      console.error('Error reading motion detection directory:', err);
      return;
    }
    
    files.forEach(file => {
      // Skip directories, focus only on frame files
      const filePath = path.join(config.motionDetectionDir, file);
      
      if (file === 'debug' || !file.startsWith('frame_')) {
        return; // Skip debug directory and non-frame files
      }
      
      fs.stat(filePath, (err, stats) => {
        if (err) {
          console.error(`Error getting stats for ${filePath}:`, err);
          return;
        }
        
        // Get the file's creation date and format it as YYYY-MM-DD
        const fileDate = new Date(stats.mtime).toISOString().split('T')[0];
        
        // Delete frames from previous days
        if (fileDate <= yesterdayStr) {
          safeDeleteFile(filePath);
          console.log(`Deleted old motion detection frame: ${file}`);
        }
      });
    });
  });
  
  // Also clean up the debug directory
  const debugDir = path.join(config.motionDetectionDir, 'debug');
  if (fs.existsSync(debugDir)) {
    fs.readdir(debugDir, (err, files) => {
      if (err) {
        console.error('Error reading debug directory:', err);
        return;
      }
      
      files.forEach(file => {
        const filePath = path.join(debugDir, file);
        fs.stat(filePath, (err, stats) => {
          if (err) {
            console.error(`Error getting stats for ${filePath}:`, err);
            return;
          }
          
          // Get the file's creation date and format it as YYYY-MM-DD
          const fileDate = new Date(stats.mtime).toISOString().split('T')[0];
          
          // Delete frames from previous days
          if (fileDate <= yesterdayStr) {
            safeDeleteFile(filePath);
            console.log(`Deleted old debug frame: ${file}`);
          }
        });
      });
    });
  }
};
// Start snapshot scheduling immediately
scheduleRandomSnapshots();

// Daily rotation now only resets snapshot timers
schedule.scheduleJob('0 0 * * *', () => {
  console.log('Running daily maintenance tasks...');
  clearAllSnapshots();
  scheduleRandomSnapshots();
  cleanupMotionFiles(); // Clean up old motion detection files
  cleanupMotionDetectionFrames();
});

// --- Visual Motion Detection Functions ---

// Capture a frame for motion detection - optimized to prevent resource leaks
async function captureMotionDetectionFrame() {
  const cameraId = "360"; // Primary camera for motion detection
  const outputPath = path.join(config.motionDetectionDir, `frame_${Date.now()}.jpg`);
  
  return new Promise((resolve, reject) => {
    try {
      const ffmpeg = spawn(config.ffmpegPath, [
        '-rtsp_transport', 'tcp',
        '-i', cameraConfig[cameraId],
        '-frames:v', '1',
        '-q:v', '5', // Lower quality for faster processing
        '-vf', `scale=${config.motionDetection.width}:${config.motionDetection.height}`,
        outputPath
      ]);
      
      // Set timeout to kill the process if it takes too long
      const timeout = setTimeout(() => {
        ffmpeg.kill();
        reject(new Error('Frame capture timeout'));
      }, 10000); // 10 seconds timeout
      
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

// Function to analyze image using sharp - optimized to prevent memory leaks
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

// Compare two frames for motion detection - optimized algorithm
async function compareFrames(currentFramePath, previousFrameData) {
  if (!previousFrameData) return { motion: false, difference: 0 };
  
  try {
    // Get the current frame data
    const currentFrame = await analyzeImageData(currentFramePath);
    const { data: currentData } = currentFrame;
    const { data: previousData } = previousFrameData;
    
    // Check if the data arrays have the same length
    if (currentData.length !== previousData.length) {
      console.warn("Frame dimensions don't match, skipping comparison");
      return { motion: false, difference: 0, currentFrame };
    }
    
    // Compare pixel values (sampling every nth pixel for performance)
    let diffPixels = 0;
    const sampleRate = config.motionDetection.sampleRate;
    const totalPixels = Math.floor(currentData.length / (sampleRate * 3)); // RGB has 3 channels
    
    // Use a more efficient loop
    const length = currentData.length;
    const step = 3 * sampleRate;
    for (let i = 0; i < length; i += step) {
      // Compare RGB values
      const diffR = Math.abs(currentData[i] - previousData[i]);
      const diffG = Math.abs(currentData[i + 1] - previousData[i + 1]);
      const diffB = Math.abs(currentData[i + 2] - previousData[i + 2]);
      
      // If any channel has significant difference, count as different pixel
      if (diffR > 30 || diffG > 30 || diffB > 30) {
        diffPixels++;
      }
    }
    
    // Calculate percentage of different pixels
    const percentageDiff = (diffPixels / totalPixels) * 100;
    const motion = percentageDiff > config.motionDetection.differenceThreshold && 
                  diffPixels > config.motionDetection.minPixelDifference;
    
    // Save debug images if motion detected
    if (motion) {
      const debugDir = path.join(config.motionDetectionDir, 'debug');
      if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
      
      // Copy the frame to debug directory
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

// Main motion detection function - Fixed to record all cameras consistently
async function detectMotion() {
  // Prevent concurrent motion detection operations
  if (state.motionDetection.isProcessing) return false;
  
  state.motionDetection.isProcessing = true;
  const currentTime = Date.now();
  
  try {
    // Only process if enough time has passed since last motion trigger
    if (currentTime - state.motionDetection.lastMotionTime < config.motionDetection.throttleTime) {
      state.motionDetection.isProcessing = false;
      return false;
    }
    
    // Clean up previous frame if it exists
    if (state.motionDetection.lastFramePath) {
      safeDeleteFile(state.motionDetection.lastFramePath);
      state.motionDetection.lastFramePath = null;
    }
    
    // Capture a new frame
    const framePath = await captureMotionDetectionFrame();
    
    // Compare with previous frame
    const result = await compareFrames(framePath, state.motionDetection.lastFrame);
    
    // Update last frame data
    state.motionDetection.lastFrame = result.currentFrame;
    state.motionDetection.lastFramePath = framePath;
    
    // Handle motion detection result
    if (result.motion) {
      state.motionDetection.consecutiveMotionFrames++;
      console.log(`Motion detected: ${result.difference.toFixed(2)}% (${result.diffPixels}/${result.totalPixels} pixels)`);
      
      // Trigger recording if we have enough consecutive motion frames
      if (state.motionDetection.consecutiveMotionFrames >= state.motionDetection.motionThreshold) {
        console.log("Motion confirmed! Triggering recordings for ALL cameras...");
        
        // Reset the counter and update last motion time
        state.motionDetection.consecutiveMotionFrames = 0;
        state.motionDetection.lastMotionTime = currentTime;
        
        // Fix: Trigger recording for ALL cameras with a slight delay between each
        const cameraIds = Object.keys(cameraConfig);
        for (let i = 0; i < cameraIds.length; i++) {
          const cameraId = cameraIds[i];
          // Add a small delay between starting each camera recording
          setTimeout(() => {
            console.log(`Motion recording triggered for camera: ${cameraId}`);
            FFmpegManager.startMotionRecording(cameraId);
          }, i * 200); // 200ms delay between each camera
        }
        
        state.motionDetection.isProcessing = false;
        return true;
      }
    } else {
      // Reset consecutive motion counter if no motion
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

// Start the motion detection loop with a safer implementation
function startMotionDetectionLoop() {
  console.log("Starting visual motion detection loop");
  
  // Run the motion detection at regular intervals
  const motionInterval = setInterval(async () => {
    if (!state.motionDetection.motionDetectionActive) return;
    
    try {
      await detectMotion();
    } catch (error) {
      console.error("Error in motion detection loop:", error);
    }
  }, config.motionDetection.interval);
  
  // Set a cleanup function to stop the intervals when needed
  process.on('SIGTERM', () => {
    clearInterval(motionInterval);
  });
  
  // Additionally, trigger recordings at random intervals as a backup
  const randomInterval = setInterval(() => {
    if (!state.motionDetection.motionDetectionActive) return;
    
    const currentTime = Date.now();
    if (currentTime - state.motionDetection.lastMotionTime > config.motionDetection.throttleTime * 2) {
      console.log("Random interval motion recording triggered (backup)");
      
      // Trigger recording for a random camera
      const cameras = Object.keys(cameraConfig);
      const randomCamera = cameras[Math.floor(Math.random() * cameras.length)];
      console.log(`Recording triggered for random camera: ${randomCamera}`);
      FFmpegManager.startMotionRecording(randomCamera);
      
      // Update the last motion time
      state.motionDetection.lastMotionTime = currentTime;
    }
  }, 3 * 60 * 60 * 1000 + Math.random() * 2 * 60 * 60 * 1000); // 3-5 hours
  
  // Set a cleanup function to stop the intervals when needed
  process.on('SIGTERM', () => {
    clearInterval(randomInterval);
  });
}

// Streaming endpoint - optimized to prevent resource leaks
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
    
    // Store the process to track active streams
    const streamId = `${cameraId}_${Date.now()}`;
    state.activeStreams.set(streamId, ffmpeg);
    
    ffmpeg.stdout.pipe(res);

    ffmpeg.stderr.on("data", (err) => {
      console.error(`FFmpeg stream error for ${cameraId}:`, err.toString());
    });

    ffmpeg.on("error", (err) => {
      console.error(`Stream process error for ${cameraId}:`, err.toString());
      state.activeStreams.delete(streamId);
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.end();
      }
    });

    // Cleanup when the request is closed
    req.on("close", () => {
      ffmpeg.kill();
      state.activeStreams.delete(streamId);
    });
    
    // Timeout to kill the stream after a certain period to prevent resource leaks
    const timeout = setTimeout(() => {
      if (state.activeStreams.has(streamId)) {
        console.log(`Stream timeout for ${cameraId}, killing process`);
        ffmpeg.kill();
        state.activeStreams.delete(streamId);
      }
    }, 60 * 60 * 1000); // 1 hour maximum stream time
    
    // Clean up the timeout if the request is closed
    req.on("close", () => {
      clearTimeout(timeout);
    });
  } catch (error) {
    console.error(`Error creating stream for ${cameraId}:`, error);
    res.status(500).send("Error creating stream");
  }
});

// Protected endpoints using basic auth
app.use('/control', basicAuth(config.auth));

// Manual trigger endpoint (for testing)
app.post('/control/motion', (req, res) => {
  // Trigger motion recording for all cameras
  Object.keys(cameraConfig).forEach(cameraId => {
    console.log(`Manual motion recording triggered for camera: ${cameraId}`);
    FFmpegManager.startMotionRecording(cameraId);
  });
  res.json({ success: true, message: "Motion recordings started for all cameras" });
});

// Manual motion detection testing endpoint
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

// Enable/disable motion detection system
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

// Motion detection settings endpoint
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

// Update motion detection settings
app.post('/control/motion-settings', (req, res) => {
  try {
    const newSettings = req.body;
    
    // Only update valid settings
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

// List all recordings
app.get('/control/recordings', (req, res) => {
  try {
    const recordings = [];
    
    // Read all date directories
    const dateDirs = fs.readdirSync(config.recordingsDir);
    
    dateDirs.forEach(dateDir => {
      const datePath = path.join(config.recordingsDir, dateDir);
      if (fs.statSync(datePath).isDirectory()) {
        // Get all recordings for this date
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
    
    // Sort by timestamp descending (newest first)
    recordings.sort((a, b) => b.timestamp - a.timestamp);
    
    res.json({ success: true, recordings });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Health endpoint
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

// System resource status
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
  // Kill all active FFmpeg

app.listen(port, () => console.log(`Server running on port ${port}`));
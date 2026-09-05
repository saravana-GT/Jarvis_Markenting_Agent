const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer-core');

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FFMPEG_PATH = path.join(__dirname, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');
const TEMP_DIR = path.join(__dirname, 'temp_video_build');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const scenes = [
  {
    id: 1,
    title: "JARVIS AGENCY PLATFORM",
    subtitle: "Local-First Web Agency Automation Platform",
    narration: "Welcome to the JARVIS Agency Platform explainer video. In this video, we will show you how JARVIS automates client discovery, website auditing, personalized outreach, and project management for web agencies.",
    caption: "Welcome to the JARVIS Agency Platform explainer video. Automate lead discovery, AI audits & client acquisition 10x faster!",
    bgImage: path.join(PUBLIC_DIR, 'images', 'hd_jarvis_dashboard_1788585706847.jpg')
  },
  {
    id: 2,
    title: "STEP 1: AUTOMATED LEAD DISCOVERY",
    subtitle: "Google Places API (New) Integration",
    narration: "Step 1: Automated Lead Discovery. Powered by the Google Places API, JARVIS lets you search any location or business niche to instantly gather qualified local business leads with verified phone numbers, addresses, and website links.",
    caption: "Step 1: Lead Discovery powered by Google Places API. Search any niche or location for verified business leads.",
    bgImage: path.join(PUBLIC_DIR, 'images', 'hd_lead_discovery_1788585772209.jpg')
  },
  {
    id: 3,
    title: "STEP 2: AI WEBSITE AUDIT ENGINE",
    subtitle: "Performance, Mobile Speed & SEO Vulnerability Analysis",
    narration: "Step 2: AI Website Audit Engine. JARVIS automatically scrapes lead websites, evaluating performance speed, mobile responsiveness, and SEO vulnerabilities to highlight key areas of improvement.",
    caption: "Step 2: AI Audit Engine automatically checks lead websites for speed, mobile responsiveness & SEO flaws.",
    bgImage: path.join(PUBLIC_DIR, 'images', 'hd_ai_audit_engine_1788585784645.jpg')
  },
  {
    id: 4,
    title: "STEP 3: PERSONALIZED EMAIL OUTREACH",
    subtitle: "Gmail API Integration & Custom Pitch Generation",
    narration: "Step 3: Automated Personalized Outreach. Integrated with the Gmail API, JARVIS crafts custom pitch emails pointing out the exact website issues discovered during the audit to maximize conversion rates.",
    caption: "Step 3: Personalized Outreach via Gmail API. Sends tailored pitch emails highlighting exact website improvements needed.",
    bgImage: path.join(PUBLIC_DIR, 'images', 'hd_outreach_calendar_1788585800332.jpg')
  },
  {
    id: 5,
    title: "STEP 4: CALENDAR & PROPOSALS",
    subtitle: "Google Calendar Booking & Single-Click PDF Proposals",
    narration: "Step 4: Calendar Booking and Proposal Generation. Prospective clients can easily book consultation meetings via Google Calendar integration, and JARVIS auto-generates professional PDF proposals and quotations in one click.",
    caption: "Step 4: Google Calendar integration & instant single-click PDF Quotation & Proposal generation.",
    bgImage: path.join(PUBLIC_DIR, 'images', 'hd_outreach_calendar_1788585800332.jpg')
  },
  {
    id: 6,
    title: "STEP 5: PROJECT & PAYMENT TRACKING",
    subtitle: "Supabase PostgreSQL Database Pipeline Management",
    narration: "Step 5: End-to-End Project Management. Track pipeline status, project deliverables, approvals, and financial payment ledger entries securely stored in the Supabase PostgreSQL database.",
    caption: "Step 5: End-to-end project management & payment tracking powered by Supabase PostgreSQL.",
    bgImage: path.join(PUBLIC_DIR, 'images', 'hd_jarvis_dashboard_1788585706847.jpg')
  },
  {
    id: 7,
    title: "ARCHITECTURE & CONCLUSION",
    subtitle: "Node.js • Express • Supabase • Google Cloud APIs",
    narration: "JARVIS is built using Node.js, Express, Supabase PostgreSQL, and Google Cloud APIs. Thank you for watching!",
    caption: "Built with Node.js, Express, Supabase PostgreSQL & Google Cloud APIs. Thank you for watching!",
    bgImage: path.join(PUBLIC_DIR, 'images', 'hd_jarvis_dashboard_1788585706847.jpg')
  }
];

function getHtmlTemplate(scene) {
  const bgBase64 = fs.readFileSync(scene.bgImage).toString('base64');
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      width: 1920px;
      height: 1080px;
      background: #000;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      color: #fff;
      overflow: hidden;
      position: relative;
    }
    .bg {
      position: absolute;
      top: 0; left: 0; width: 100%; height: 100%;
      background-image: url('data:image/jpeg;base64,${bgBase64}');
      background-size: cover;
      background-position: center;
      opacity: 0.75;
    }
    .overlay {
      position: absolute;
      top: 0; left: 0; width: 100%; height: 100%;
      background: linear-gradient(180deg, rgba(8,12,20,0.6) 0%, rgba(8,12,20,0.9) 100%);
    }
    .header-box {
      position: absolute;
      top: 60px;
      left: 80px;
      background: rgba(15, 22, 36, 0.85);
      border: 2px solid #00f2fe;
      padding: 16px 36px;
      border-radius: 40px;
      box-shadow: 0 0 30px rgba(0, 242, 254, 0.3);
    }
    .header-title {
      font-size: 32px;
      font-weight: 800;
      letter-spacing: 2px;
      color: #00f2fe;
    }
    .sub-title {
      font-size: 20px;
      color: #94a3b8;
      margin-top: 4px;
    }
    .subtitle-banner {
      position: absolute;
      bottom: 80px;
      left: 100px;
      right: 100px;
      background: rgba(10, 14, 24, 0.92);
      border: 2px solid rgba(0, 242, 254, 0.6);
      border-radius: 20px;
      padding: 30px 45px;
      text-align: center;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.8);
      backdrop-filter: blur(10px);
    }
    .caption-text {
      font-size: 36px;
      font-weight: 700;
      color: #ffffff;
      line-height: 1.4;
      text-shadow: 0 2px 10px rgba(0,0,0,0.5);
    }
    .watermark {
      position: absolute;
      top: 60px;
      right: 80px;
      font-size: 24px;
      font-weight: 800;
      color: rgba(255,255,255,0.7);
      background: rgba(255,255,255,0.1);
      padding: 10px 24px;
      border-radius: 30px;
      border: 1px solid rgba(255,255,255,0.2);
    }
  </style>
</head>
<body>
  <div class="bg"></div>
  <div class="overlay"></div>
  
  <div class="header-box">
    <div class="header-title">${scene.title}</div>
    <div class="sub-title">${scene.subtitle}</div>
  </div>

  <div class="watermark">JARVIS PLATFORM</div>

  <div class="subtitle-banner">
    <div class="caption-text">"${scene.caption}"</div>
  </div>
</body>
</html>
  `;
}

async function buildVideo() {
  console.log("🚀 Starting Full English Video Generation Process...");

  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  const sceneFiles = [];

  for (const scene of scenes) {
    console.log(`\n🎬 Processing Scene ${scene.id}/${scenes.length}: ${scene.title}...`);

    // 1. Render PNG Frame
    const htmlContent = getHtmlTemplate(scene);
    await page.setContent(htmlContent, { waitUntil: 'load' });
    const imgPath = path.join(TEMP_DIR, `scene_${scene.id}.png`);
    await page.screenshot({ path: imgPath, type: 'png' });
    console.log(`   📸 Frame saved: scene_${scene.id}.png`);

    // 2. Generate Audio WAV via PowerShell
    const wavPath = path.join(TEMP_DIR, `scene_${scene.id}.wav`);
    console.log(`   🗣️ Generating English TTS audio...`);
    const psCmd = `powershell -ExecutionPolicy Bypass -File "${path.join(__dirname, 'make_tts.ps1')}" -text "${scene.narration.replace(/"/g, '\"')}" -outFile "${wavPath}"`;
    execSync(psCmd, { stdio: 'inherit' });

    // 3. Render Scene Video Segment MP4 using FFmpeg
    const segmentMp4 = path.join(TEMP_DIR, `scene_${scene.id}.mp4`);
    console.log(`   🎥 Rendering MP4 segment for scene ${scene.id}...`);
    
    // FFmpeg command to combine image + audio WAV into an H.264 / AAC mp4 video file
    const ffmpegCmd = `"${FFMPEG_PATH}" -y -loop 1 -i "${imgPath}" -i "${wavPath}" -c:v libx264 -tune stillimage -c:a aac -b:a 192k -pix_fmt yuv420p -shortest "${segmentMp4}"`;
    execSync(ffmpegCmd, { stdio: 'ignore' });
    console.log(`   ✅ Segment complete: scene_${scene.id}.mp4`);

    sceneFiles.push(segmentMp4);
  }

  await browser.close();

  // 4. Concatenate all scene segments into final MP4 and MKV
  console.log("\n🎞️ Concatenating all scenes into final video files...");
  
  const listFile = path.join(TEMP_DIR, 'files.txt');
  const fileLines = sceneFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
  fs.writeFileSync(listFile, fileLines);

  const finalMp4 = path.join(PUBLIC_DIR, 'jarvis_explainer_video.mp4');
  const finalMkv = path.join(PUBLIC_DIR, 'jarvis_explainer_video.mkv');

  const concatMp4Cmd = `"${FFMPEG_PATH}" -y -f concat -safe 0 -i "${listFile}" -c copy "${finalMp4}"`;
  execSync(concatMp4Cmd, { stdio: 'inherit' });
  console.log(`🎉 SUCCESS! Final MP4 created: ${finalMp4}`);

  const concatMkvCmd = `"${FFMPEG_PATH}" -y -f concat -safe 0 -i "${listFile}" -c copy "${finalMkv}"`;
  execSync(concatMkvCmd, { stdio: 'inherit' });
  console.log(`🎉 SUCCESS! Final MKV created: ${finalMkv}`);

  // Cleanup temp files
  console.log("🧹 Cleaning up build files...");
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });

  console.log("\n=======================================================");
  console.log("🎬 FULL ENGLISH EXPLAINER VIDEO RENDERING COMPLETE!");
  console.log(`📹 MP4 File: file:///${finalMp4.replace(/\\/g, '/')}`);
  console.log(`📹 MKV File: file:///${finalMkv.replace(/\\/g, '/')}`);
  console.log("=======================================================\n");
}

buildVideo().catch(err => {
  console.error("❌ Video Generation Error:", err);
  process.exit(1);
});

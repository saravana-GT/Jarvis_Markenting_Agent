const fs = require('fs');
const readline = require('readline');
const path = require('path');

const logPath = 'C:\\Users\\sarav\\.gemini\\antigravity\\brain\\a7fc5204-d264-445f-b648-c5030db26935\\.system_generated\\logs\\transcript.jsonl';

const rl = readline.createInterface({
  input: fs.createReadStream(logPath),
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  try {
    const obj = JSON.parse(line);
    if (obj.type === 'USER_INPUT') {
      console.log(`\n[USER]: ${obj.content}`);
    } else if (obj.type === 'PLANNER_RESPONSE' && obj.content) {
      // Print truncated model response
      console.log(`[MODEL]: ${obj.content.slice(0, 300)}...`);
    }
  } catch (e) {
    // Ignore invalid JSON lines
  }
});

// services/ttsService.js
//
// AI Voices using ElevenLabs API.
// Uses native Node.js fetch, no external TTS libraries required.

import fs from "fs/promises";
import path from "path";
import { runFfmpeg, ffprobeDuration, getAtempoFilter } from "../utils/mediaUtils.js";

const AUDIO_SAMPLE_RATE = 44100;
const MIN_SPEED = 0.92;
const MAX_SPEED = 1.18;

// Map your frontend UI IDs to real ElevenLabs Voice IDs.
// These are default ElevenLabs voices. You can replace these IDs 
// with your cloned voices from the ElevenLabs VoiceLab.
const VOICE_MAP = {
  hi: {
    female_1: '21m00Tcm4TlvDq8ikWAM', // Rachel
    male_1: '29vD33N1CtxCmqQRPOZB',   // Drew
    female_2: 'zrHiDhphv9ZnVXBqCLjz', // Mimi
    male_2: '2EiwWnXFnvU5JabPnv8n'    // Clyde
  },
  en: {
    female_1: '21m00Tcm4TlvDq8ikWAM', // Rachel
    male_1: '29vD33N1CtxCmqQRPOZB',   // Drew
    female_2: 'zrHiDhphv9ZnVXBqCLjz', // Mimi
    male_2: '2EiwWnXFnvU5JabPnv8n'    // Clyde
  }
};

export function countSpokenWords(text) {
  const matches = String(text).match(/[A-Za-z0-9\u0900-\u097F]+/g);
  return matches ? matches.length : 0;
}

// 👇 Replaced Microsoft Edge logic with ElevenLabs API
async function synthesizeRaw(text, outputPath, lang, voiceId = 'female_1') {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY is not set in your .env file");
  }

  // Fallback to a default voice if the mapped one is missing
  const specificVoice = VOICE_MAP[lang]?.[voiceId] || VOICE_MAP['en']['female_1'];

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${specificVoice}`, {
    method: 'POST',
    headers: {
      'Accept': 'audio/mpeg',
      'xi-api-key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      text: text,
      // eleven_multilingual_v2 is the best model for both English and Hindi/Hinglish
      model_id: 'eleven_multilingual_v2', 
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs API Error (${response.status}): ${errorText}`);
  }

  // Convert the response to a buffer and save it to disk
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  await fs.writeFile(outputPath, buffer);

  return outputPath;
}

async function assertNonTrivialAudioFile(filePath, label) {
  const stats = await fs.stat(filePath).catch(() => null);
  if (!stats || stats.size < 200) {
    throw new Error(
      `${label} produced an empty audio file. Ensure your ElevenLabs API limits haven't been exceeded.`
    );
  }
}

export async function trimSilence(rawPath, trimmedPath) {
  await runFfmpeg([
    "-y",
    "-i", rawPath,
    "-af",
    "silenceremove=start_periods=1:start_duration=0.02:start_threshold=-45dB:" +
      "stop_periods=-1:stop_duration=0.04:stop_threshold=-45dB",
    "-ar", String(AUDIO_SAMPLE_RATE),
    "-ac", "2",
    "-c:a", "pcm_s16le",
    trimmedPath,
  ]);
}

export async function safeTrimSilence(rawPath, trimmedPath) {
  await trimSilence(rawPath, trimmedPath);

  try {
    const duration = await ffprobeDuration(trimmedPath);
    if (duration > 0.15) return;
  } catch {
    // unreadable - fall through to the untrimmed fallback below
  }

  await runFfmpeg([
    "-y",
    "-i", rawPath,
    "-ar", String(AUDIO_SAMPLE_RATE),
    "-ac", "2",
    "-c:a", "pcm_s16le",
    trimmedPath,
  ]);
}

async function matchSegmentSpeed(trimmedPath, segmentPath, preferredDuration) {
  const rawDuration = await ffprobeDuration(trimmedPath);
  const requiredSpeed = rawDuration / Math.max(preferredDuration, 0.5);
  const speedFactor = Math.min(Math.max(requiredSpeed, MIN_SPEED), MAX_SPEED);
  const atempoFilter = getAtempoFilter(speedFactor);

  await runFfmpeg([
    "-y",
    "-i", trimmedPath,
    "-af", `${atempoFilter},asetpts=N/SR/TB`,
    "-ar", String(AUDIO_SAMPLE_RATE),
    "-ac", "2",
    "-c:a", "pcm_s16le",
    segmentPath,
  ]);

  const actualDuration = await ffprobeDuration(segmentPath);
  return { speedFactor, actualDuration };
}

async function concatSegments(segmentPaths, workDir, outputPath) {
  const listFile = path.join(workDir, "audio_segments.txt");
  const listContent = segmentPaths
    .map((segmentPath) => `file '${segmentPath.replace(/'/g, "'\\''")}'`)
    .join("\n");

  await fs.writeFile(listFile, listContent, "utf-8");

  await runFfmpeg([
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listFile,
    "-c:a", "pcm_s16le",
    "-ar", String(AUDIO_SAMPLE_RATE),
    "-ac", "2",
    outputPath,
  ]);

  return outputPath;
}

export async function createSyncedNarration({ voiceoverLines, preferredDuration, workDir, lang = "hi", voiceId = "female_1" }) {
  const segmentPaths = [];
  const speedFactors = [];
  const segmentDurations = [];

  for (let index = 0; index < voiceoverLines.length; index += 1) {
    const line = voiceoverLines[index];
    
    const rawPath = path.join(workDir, `voice_raw_${index}.mp3`);
    const trimmedPath = path.join(workDir, `voice_trimmed_${index}.wav`);
    const segmentPath = path.join(workDir, `voice_segment_${index}.wav`);

    try {
      await synthesizeRaw(line, rawPath, lang, voiceId);
      
      await assertNonTrivialAudioFile(rawPath, `Photo ${index + 1} voiceover`);
      await safeTrimSilence(rawPath, trimmedPath);

      const { speedFactor, actualDuration } = await matchSegmentSpeed(
        trimmedPath,
        segmentPath,
        preferredDuration
      );

      segmentPaths.push(segmentPath);
      speedFactors.push(speedFactor);
      segmentDurations.push(actualDuration);
    } catch (error) {
      throw new Error(
        `Failed to prepare voice audio for photo ${index + 1} ("${line.slice(0, 40)}${line.length > 40 ? "…" : ""}"): ${error.message}`
      );
    }
  }

  const combinedAudioPath = path.join(workDir, "continuous_voice.wav");
  await concatSegments(segmentPaths, workDir, combinedAudioPath);

  return { combinedAudioPath, speedFactors, segmentDurations };
}

export function splitDurationsByWordWeight(voiceoverLines, totalAudioDuration) {
  const minimumPhotoDuration = 0.5;
  const requiredMinimum = voiceoverLines.length * minimumPhotoDuration;

  if (totalAudioDuration <= requiredMinimum) {
    throw new Error(
      "The uploaded voiceover is too short for the number of photos. Upload a longer recording."
    );
  }

  const wordWeights = voiceoverLines.map((line) => Math.max(countSpokenWords(line), 1));
  const totalWeight = wordWeights.reduce((sum, weight) => sum + weight, 0);
  const distributableDuration = totalAudioDuration - requiredMinimum;

  return wordWeights.map(
    (weight) => minimumPhotoDuration + (distributableDuration * weight) / totalWeight
  );
}

export { AUDIO_SAMPLE_RATE };
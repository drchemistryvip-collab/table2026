import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI } from '@google/genai';
import { 
  WeekSchedule, 
  LessonSlot, 
  CLASSES, 
  GRADES,
  SECTIONS,
  ALL_SUBJECTS,
  DAYS, 
  AlarmSettings, 
  DEFAULT_ALARM_SETTINGS,
  ALARM_SOUNDS, 
  THEMES, 
  ShiftType,
  STANDARD_SECTIONS,
  ALL_KURDISH_SECTIONS,
  getActiveSections,
  generateClassList,
  DEFAULT_DAY_SHIFTS,
  ScheduleChangeRequest
} from './types';
import { INITIAL_SCHEDULE, VOICE_SCRIPTS, calculateSlotTimes, generateSlotsForDay } from './constants';

// Check if running on a static host (like GitHub Pages)
const isStaticHost = () => {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return host.includes('github.io') || host.includes('githubusercontent.com') || host.includes('netlify.app') || host.includes('vercel.app');
};

// Fast fetch helper with short timeout for server endpoints to prevent hanging on static hosts
const fetchServerWithTimeout = async (url: string, options: RequestInit, timeoutMs = 1200) => {
  if (isStaticHost()) {
    throw new Error("Static host detected - bypassing server endpoint immediately");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
};

const CLIENT_GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-1.5-flash",
  "gemini-2.0-flash",
  "gemini-2.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-2.5-pro",
  "gemini-1.5-pro",
];

const sanitizeApiKey = (key?: string) => {
  if (!key) return '';
  return key.replace(/^["']|["']$/g, '').trim();
};

const callClientGeminiValidate = async (apiKeyToUse: string) => {
  const cleanKey = sanitizeApiKey(apiKeyToUse);
  if (!cleanKey) {
    throw new Error("تکایە API Key ل لاکێشا خوارێ بنڤێسە (Key is required)");
  }
  const aiClient = new GoogleGenAI({ apiKey: cleanKey });
  let lastErr: any = null;
  for (const m of CLIENT_GEMINI_MODELS) {
    try {
      const res = await aiClient.models.generateContent({
        model: m,
        contents: "Respond with OK to test key connection.",
      });
      if (res && res.text) {
        return { valid: true, model: m };
      }
    } catch (err: any) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("کلیل خەلەتە یان چالاک نینە");
};

const callClientGeminiExtract = async (apiKeyToUse: string, imageBase64Data: string, mimeTypeStr: string, customPromptStr?: string) => {
  const cleanKey = sanitizeApiKey(apiKeyToUse);
  if (!cleanKey) {
    throw new Error("تکایە API Key بنڤێسە دا خشتەی بەرهەم بینیت");
  }

  let base64Clean = imageBase64Data;
  if (base64Clean.includes(",")) {
    base64Clean = base64Clean.split(",")[1];
  }

  const promptText = `
You are an expert school timetable OCR scanner and analyzer specializing in Kurdish / Arabic school schedules (aSC Timetables, Minha Escola, and manual school charts).

CRITICAL EXTRACTION RULES:
1. READ COLUMN HEADERS CAREFULLY:
   - The table header row contains period numbers: 1, 2, 3, 4, 5, 6 (or 1 to 8).
   - In Kurdish/Arabic timetables, period 1 (وانا 1 / الدرس 1 / 1) is next to the Day column (usually on the right side).
   - Period 1 MUST map to index 0 of the \`lessons\` array.
   - Period 2 MUST map to index 1 of the \`lessons\` array.
   - Period 3 MUST map to index 2 of the \`lessons\` array.
   - Period 4 MUST map to index 3 of the \`lessons\` array.
   - Period 5 MUST map to index 4 of the \`lessons\` array.
   - Period 6 MUST map to index 5 of the \`lessons\` array.
   - DO NOT INVERT OR REVERSE THE PERIOD ORDER.

2. READ DAY NAMES CAREFULLY:
   - Map Kurdish day names accurately:
     "ئێکشەمبی" / "ئێك شه مبی" -> "ئێکشەمبی"
     "دووشەمبی" / "دوو شه مبی" -> "دووشەمبی"
     "سێشەمبی" / "سی شه مبی" -> "سێشەمبی"
     "چوارشەمبی" / "چار شه مبی" -> "چوارشەمبی"
     "پێنچ شەمبی" / "پینج شه مبی" -> "پێنچ شەمبی"

3. READ CLASS / GRADE / SECTION NAMES CAREFULLY:
   - Grade numbers: 1 to 12 (e.g. 10, 11, 12, 1, 2, 3...)
   - Kurdish / Arabic section letters: أ, ب, ج, د, هـ, و, ز, ح, ط...
   - Examples of valid cell text: "10 - ب", "10 - ج", "10 - د", "10 - هـ", "10 - و", "پۆلا 10 - د", "12 - زانستی أ", "11 - ب".
   - IF A CELL IS EMPTY OR BLANK OR HAS NO CLASS NAME: Write strictly "بێ وانە".
   - Make sure every day has the EXACT same array length corresponding to the total period count (e.g. exactly 6 elements for 6 periods).

4. TEACHER & SUBJECT EXTRACTION:
   - Teacher Name: Look at the top title (e.g. "م حسێن", "م. حوسێن", "مامۆستا حسێن").
   - Subject Name: Look at small text inside cells or top title (e.g. "کیمیا", "فیزیا", "بیرکاری", "زانست", "کوردی", etc.).

${customPromptStr ? `USER SPECIAL INSTRUCTION: ${customPromptStr}` : ""}

Return ONLY a valid JSON object matching this schema:
{
  "teacherName": string,
  "subject": string,
  "lessonCountPerDay": number,
  "days": [
    {
      "dayName": "ئێکشەمبی" | "دووشەمبی" | "سێشەمبی" | "چوارشەمبی" | "پێنچ شەمبی",
      "shift": "morning" | "evening",
      "lessons": string[]
    }
  ],
  "notes": string
}
`;

  const aiClient = new GoogleGenAI({ apiKey: cleanKey });
  let lastErr: any = null;
  for (const m of CLIENT_GEMINI_MODELS) {
    try {
      const res = await aiClient.models.generateContent({
        model: m,
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: mimeTypeStr || "image/jpeg",
                data: base64Clean,
              },
            },
            {
              text: promptText,
            },
          ],
        },
        config: {
          responseMimeType: "application/json",
        },
      });

      if (res && res.text) {
        const cleaned = res.text.replace(/```json/g, "").replace(/```/g, "").trim();
        return JSON.parse(cleaned);
      }
    } catch (err: any) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("دەرهێنانا خشتەی سەرکەوتوو نەبوو");
};

const callClientGeminiTiming = async (apiKeyToUse: string, promptStr: string, currentSettings: any) => {
  const cleanKey = sanitizeApiKey(apiKeyToUse);
  if (!cleanKey) {
    throw new Error("تکایە API Key بنڤێسە");
  }

  const systemInstruction = `
You are an intelligent school bell & timetable configuration assistant for Kurdish schools (Badini / Sorani Kurdish).
The user wants to configure lesson durations, break timings, shift lengths, lesson counts, or exam mode.

Analyze the user's Kurdish command: "${promptStr}".
Existing settings context: ${JSON.stringify(currentSettings || {})}.

Return JSON with this exact structure:
{
  "morningDuration": number,
  "eveningDuration": number,
  "lessonCount": number,
  "defaultBreakDuration": number,
  "longBreakLesson": number,
  "longBreakDuration": number,
  "examSettings": {
    "enabled": boolean,
    "examLessonNumber": number,
    "examDuration": number,
    "otherLessonsDuration": number,
    "breakAfterExam": number
  },
  "summaryKurdish": string
}
`;

  const aiClient = new GoogleGenAI({ apiKey: cleanKey });
  let lastErr: any = null;
  for (const m of CLIENT_GEMINI_MODELS) {
    try {
      const res = await aiClient.models.generateContent({
        model: m,
        contents: promptStr,
        config: {
          systemInstruction,
          responseMimeType: "application/json",
        },
      });

      if (res && res.text) {
        const cleaned = res.text.replace(/```json/g, "").replace(/```/g, "").trim();
        return JSON.parse(cleaned);
      }
    } catch (err: any) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("گۆڕینی کاتەکان سەرکەوتوو نەبوو");
};

const callClientGeminiTts = async (apiKeyToUse: string, textStr: string, voiceGenderStr: string) => {
  const cleanKey = sanitizeApiKey(apiKeyToUse);
  if (!cleanKey) {
    throw new Error("تکایە API Key بنڤێسە");
  }

  const voiceName = voiceGenderStr === "female" ? "Kore" : "Puck";
  const aiClient = new GoogleGenAI({ apiKey: cleanKey });
  let lastErr: any = null;
  for (const m of ["gemini-2.5-flash", "gemini-3.8-flash-lite-tts", "gemini-2.5-flash-lite", "gemini-1.5-flash"]) {
    try {
      const res = await aiClient.models.generateContent({
        model: m,
        contents: [{ role: "user", parts: [{ text: textStr }] }],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        },
      });

      const audioBase64 = res.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (audioBase64) {
        return audioBase64;
      }
    } catch (err: any) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("دروستکردنی دەنگ سەرکەوتوو نەبوو");
};
import { collection, onSnapshot, doc } from 'firebase/firestore';
import { 
  db, 
  TIMETABLES_COLLECTION, 
  fetchTimetablesFromFirestore, 
  saveTimetableToFirestore, 
  batchSaveTimetablesToFirestore, 
  deleteTimetableFromFirestore,
  SCHOOL_SETTINGS_COLLECTION,
  SETTINGS_GLOBAL_DOC,
  saveSchoolSettingsToFirestore,
  fetchSchoolSettingsFromFirestore,
  SCHEDULE_CHANGE_REQUESTS_COLLECTION,
  submitScheduleChangeRequest,
  updateScheduleChangeRequestStatus,
  deleteScheduleChangeRequest
} from './firebase';
import { TeacherTimetableDoc, SwapSuggestion } from './types';

import { 
  Clock, 
  Save, 
  Sun, 
  Moon, 
  Edit3, 
  CheckCircle,
  LayoutGrid,
  Bell,
  Settings,
  X,
  Play,
  Grid,
  Smartphone,
  Plus,
  ArrowLeftRight,
  Volume2,
  DownloadCloud,
  Loader2,
  User,
  UserCircle,
  Palette,
  Coffee,
  AlertCircle,
  Mic,
  MonitorPlay,
  Upload,
  WifiOff,
  Hourglass,
  Download,
  VolumeX,
  RotateCcw,
  Search,
  Sparkles,
  Camera,
  Image as ImageIcon,
  Wand2,
  GraduationCap,
  Calendar,
  Check,
  CheckCircle2,
  HardDrive,
  FileJson,
  Share2,
  ArrowDownToLine,
  Trash2,
  FolderUp,
  Key,
  ExternalLink,
  Eye,
  EyeOff,
  ShieldCheck,
  Shuffle,
  Lock,
  Unlock,
  ShieldAlert,
  FileText,
  Layers,
  Building2,
  Users,
  CheckSquare,
  Code,
  Copy,
  Menu
} from 'lucide-react';


const DB_NAME = "TeacherHusseinVoiceDB_v6";
const STORE_NAME = "voices";

const openDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const saveVoice = async (id: string, audioData: Uint8Array) => {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  tx.objectStore(STORE_NAME).put(audioData, id);
  return new Promise((resolve) => (tx.oncomplete = resolve));
};

const getVoice = async (id: string): Promise<Uint8Array | null> => {
  const db = await openDB();
  const tx = db.transaction(STORE_NAME, "readonly");
  const request = tx.objectStore(STORE_NAME).get(id);
  return new Promise((resolve) => (request.onsuccess = () => resolve(request.result || null)));
};

// Dual Offline Backup Store (IndexedDB for App Data & Schedule)
const BACKUP_DB_NAME = "TeacherHusseinBackupDB_v1";
const BACKUP_STORE = "schedule_backup";

const openBackupDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(BACKUP_DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(BACKUP_STORE)) {
        request.result.createObjectStore(BACKUP_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const saveBackupData = async (key: string, data: any) => {
  try {
    const db = await openBackupDB();
    const tx = db.transaction(BACKUP_STORE, "readwrite");
    tx.objectStore(BACKUP_STORE).put(data, key);
    return new Promise((resolve) => (tx.oncomplete = resolve));
  } catch (e) {
    console.warn("IndexedDB backup error:", e);
  }
};

const getBackupData = async (key: string): Promise<any | null> => {
  try {
    const db = await openBackupDB();
    const tx = db.transaction(BACKUP_STORE, "readonly");
    const request = tx.objectStore(BACKUP_STORE).get(key);
    return new Promise((resolve) => (request.onsuccess = () => resolve(request.result || null)));
  } catch (e) {
    console.warn("IndexedDB restore error:", e);
    return null;
  }
};

// Safe Merge Utility to prevent overwriting user schedule during app updates
const mergeUserSchedule = (savedSchedule: WeekSchedule, initialTemplate: WeekSchedule): WeekSchedule => {
  if (!savedSchedule || typeof savedSchedule !== 'object') return initialTemplate;
  const merged: WeekSchedule = {};

  DAYS.forEach((day) => {
    const defaultDay = initialTemplate[day];
    const savedDay = savedSchedule[day];

    if (!savedDay) {
      merged[day] = defaultDay;
    } else {
      merged[day] = {
        ...defaultDay,
        ...savedDay,
        slots: Array.isArray(savedDay.slots) && savedDay.slots.length > 0
          ? savedDay.slots
          : defaultDay.slots,
      };
    }
  });

  return merged;
};

export const getDayShift = (dayName: string, sched?: WeekSchedule, settings?: AlarmSettings): ShiftType => {
  if (settings?.dayShifts && settings.dayShifts[dayName]) {
    return settings.dayShifts[dayName];
  }
  if (DEFAULT_DAY_SHIFTS[dayName]) {
    return DEFAULT_DAY_SHIFTS[dayName];
  }
  return (dayName === 'ئێکشەمبی' || dayName === 'دووشەمبی') ? 'evening' : 'morning';
};

export const reconcileScheduleWithDayShifts = (
  sched: WeekSchedule,
  settings: AlarmSettings = DEFAULT_ALARM_SETTINGS
): WeekSchedule => {
  if (!sched || typeof sched !== 'object') return INITIAL_SCHEDULE;
  const reconciled: WeekSchedule = {};

  DAYS.forEach((dayName) => {
    const existingDay = sched[dayName] || INITIAL_SCHEDULE[dayName];
    const targetShift = getDayShift(dayName, sched, settings);
    const times = calculateSlotTimes(targetShift, settings);
    const existingSlots = existingDay?.slots || [];
    const count = settings.lessonCount || 6;
    const newSlots: LessonSlot[] = [];

    for (let i = 0; i < count; i++) {
      const t = times[i] || { 
        start: targetShift === 'morning' ? (settings.morningStartTime || "08:00") : (settings.eveningStartTime || "12:30"), 
        end: targetShift === 'morning' ? "08:35" : "13:00", 
        isExam: false 
      };
      const ex = existingSlots[i];
      newSlots.push({
        id: ex ? ex.id : `slot_${dayName}_${i}_${Math.random().toString(36).substring(2, 6)}`,
        lessonNumber: i + 1,
        startTime: t.start,
        endTime: t.end,
        className: ex ? ex.className : 'بێ وانە',
        subject: ex ? ex.subject : 'کیمیا',
        isExam: t.isExam,
      });
    }

    reconciled[dayName] = {
      ...existingDay,
      dayName,
      shift: targetShift,
      slots: newSlots,
    };
  });

  return reconciled;
};

const DEFAULT_SEED_TEACHERS: TeacherTimetableDoc[] = [
  {
    id: 'teacher_hussein',
    teacherName: 'م حسێن',
    subject: 'کیمیا',
    lessonCountPerDay: 6,
    schedule: INITIAL_SCHEDULE,
    notes: 'م حسێن - کیمیا',
    updatedAt: new Date().toISOString()
  },
  {
    id: 'teacher_ahmad',
    teacherName: 'م. ئەحمەد',
    subject: 'فیزیا',
    lessonCountPerDay: 6,
    schedule: {
      'ئێکشەمبی': { dayName: 'ئێکشەمبی', shift: 'evening', slots: generateSlotsForDay('evening', ['10 - د', '10 - ب', 'بێ وانە', '10 - و', 'بێ وانە', '10 - هـ']) },
      'دووشەمبی': { dayName: 'دووشەمبی', shift: 'evening', slots: generateSlotsForDay('evening', ['10 - هـ', 'بێ وانە', '10 - ج', '10 - ب', 'بێ وانە', '10 - و']) },
      'سێشەمبی': { dayName: 'سێشەمبی', shift: 'morning', slots: generateSlotsForDay('morning', ['10 - و', '10 - هـ', 'بێ وانە', '10 - د', 'بێ وانە', '10 - ج']) },
      'چوارشەمبی': { dayName: 'چوارشەمبی', shift: 'morning', slots: generateSlotsForDay('morning', ['10 - ب', '10 - د', 'بێ وانە', '10 - هـ', '10 - ج', '10 - و']) },
      'پێنچ شەمبی': { dayName: 'پێنچ شەمبی', shift: 'morning', slots: generateSlotsForDay('morning', ['10 - د', '10 - و', 'بێ وانە', '10 - ب', 'بێ وانە', '10 - هـ']) }
    },
    notes: 'م. ئەحمەد - فیزیا',
    updatedAt: new Date().toISOString()
  },
  {
    id: 'teacher_araz',
    teacherName: 'م. ئاراز',
    subject: 'بیرکاری',
    lessonCountPerDay: 6,
    schedule: {
      'ئێکشەمبی': { dayName: 'ئێکشەمبی', shift: 'evening', slots: generateSlotsForDay('evening', ['10 - ج', 'بێ وانە', '10 - ب', '10 - د', 'بێ وانە', '10 - هـ']) },
      'دووشەمبی': { dayName: 'دووشەمبی', shift: 'evening', slots: generateSlotsForDay('evening', ['10 - د', '10 - ج', 'بێ وانە', '10 - و', 'بێ وانە', '10 - ب']) },
      'سێشەمبی': { dayName: 'سێشەمبی', shift: 'morning', slots: generateSlotsForDay('morning', ['10 - ب', '10 - د', 'بێ وانە', '10 - ج', 'بێ وانە', '10 - و']) },
      'چوارشەمبی': { dayName: 'چوارشەمبی', shift: 'morning', slots: generateSlotsForDay('morning', ['10 - ج', '10 - و', 'بێ وانە', '10 - د', '10 - هـ', '10 - ب']) },
      'پێنچ شەمبی': { dayName: 'پێنچ شەمبی', shift: 'morning', slots: generateSlotsForDay('morning', ['10 - و', '10 - ب', 'بێ وانە', '10 - ج', 'بێ وانە', '10 - د']) }
    },
    notes: 'م. ئاراز - بیرکاری',
    updatedAt: new Date().toISOString()
  }
];

const OFFLINE_TEACHERS_STORAGE_KEY = 'offline_all_teachers_cache_v3';

const getInitialAllTeachersList = (): TeacherTimetableDoc[] => {
  try {
    const cached = localStorage.getItem(OFFLINE_TEACHERS_STORAGE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((t: TeacherTimetableDoc) => ({
          ...t,
          schedule: reconcileScheduleWithDayShifts(t.schedule, DEFAULT_ALARM_SETTINGS)
        }));
      }
    }
  } catch (err) {
    console.warn("Failed reading cached teachers list:", err);
  }
  return DEFAULT_SEED_TEACHERS.map((t) => ({
    ...t,
    schedule: reconcileScheduleWithDayShifts(t.schedule, DEFAULT_ALARM_SETTINGS)
  }));
};

const getKurdishDayName = (date: Date = new Date()): string => {
  const day = date.getDay(); // 0: Sunday, 1: Monday, 2: Tuesday, 3: Wednesday, 4: Thursday, 5: Friday, 6: Saturday
  switch (day) {
    case 0: return 'ئێکشەمبی';
    case 1: return 'دووشەمبی';
    case 2: return 'سێشەمبی';
    case 3: return 'چوارشەمبی';
    case 4: return 'پێنچ شەمبی';
    case 5: return 'ئێکشەمبی'; // Friday (Weekend) -> default to Sunday
    case 6: return 'ئێکشەمبی'; // Saturday (Weekend) -> default to Sunday
    default: return 'ئێکشەمبی';
  }
};

const getFormattedFullKurdishDate = (date: Date = new Date()): string => {
  const kurdishMonths = [
    'کانوونی دووەم', 'شوبات', 'ئازار', 'نیسان', 'ئایار', 'حوزەیران',
    'تەممووز', 'ئاب', 'ئەیلوول', 'تشرینی یەکەم', 'تشرینی دووەم', 'کانوونی یەکەم'
  ];
  const dayName = getKurdishDayName(date);
  const dayNum = date.getDate();
  const monthName = kurdishMonths[date.getMonth()];
  const yearNum = date.getFullYear();

  return `${dayName}، ${dayNum}ی ${monthName} ${yearNum}`;
};

const App: React.FC = () => {
  const [schedule, setSchedule] = useState<WeekSchedule>(() => {
    try {
      const saved = localStorage.getItem('timetable_data');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object') {
          return reconcileScheduleWithDayShifts(parsed, DEFAULT_ALARM_SETTINGS);
        }
      }
    } catch (e) {}
    return reconcileScheduleWithDayShifts(INITIAL_SCHEDULE, DEFAULT_ALARM_SETTINGS);
  });
  const [activeDay, setActiveDay] = useState<string>(getKurdishDayName(new Date()));
  const [editingSlotId, setEditingSlotId] = useState<string | null>(null);
  const [isSaved, setIsSaved] = useState<boolean>(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [settingsActiveTab, setSettingsActiveTab] = useState<'timing' | 'exam' | 'ai' | 'voice' | 'storage' | 'general'>('timing');
  const [activeAlarm, setActiveAlarm] = useState<{ title: string; msg: string } | null>(null);
  const [viewMode, setViewMode] = useState<'modern' | 'classic' | 'live'>('modern');
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [readyVoices, setReadyVoices] = useState<string[]>([]);
  const [voiceGender, setVoiceGender] = useState<'male' | 'female'>('male');
  const [customScripts, setCustomScripts] = useState<Record<string, string>>(VOICE_SCRIPTS);
  const [teacherName, setTeacherName] = useState<string>(() => localStorage.getItem('teacher_name') || "ماموستا حوسێن");
  const [teacherSubject, setTeacherSubject] = useState<string>(() => localStorage.getItem('teacher_subject') || "کیمیا");
  const [activeTheme, setActiveTheme] = useState(THEMES[0]);
  const [fitMobileScreen, setFitMobileScreen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('fit_mobile_screen');
      return saved !== null ? JSON.parse(saved) : true;
    } catch (e) {
      return true;
    }
  });
  const [tablePastelTheme, setTablePastelTheme] = useState<'rose' | 'indigo' | 'emerald' | 'amber'>(() => {
    try {
      return (localStorage.getItem('table_pastel_theme') as any) || 'rose';
    } catch (e) {
      return 'rose';
    }
  });

  // PWA Install & Platform Detection
  const [isStandalone, setIsStandalone] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [showInstallGuideModal, setShowInstallGuideModal] = useState(false);

  // Custom Gemini API Key State
  const [userApiKey, setUserApiKey] = useState<string>(() => localStorage.getItem('user_gemini_api_key') || '');
  const [showApiKeyText, setShowApiKeyText] = useState<boolean>(false);

  // Online / Offline Data Safety Status Toast State
  const [onlineToast, setOnlineToast] = useState<string | null>(null);

  // AI Timetable Extraction Modal State
  const [showAiImportModal, setShowAiImportModal] = useState(false);
  const [aiExtracting, setAiExtracting] = useState(false);
  const [aiPreviewData, setAiPreviewData] = useState<any>(null);
  const [aiImagePreview, setAiImagePreview] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiSuccessMessage, setAiSuccessMessage] = useState<string | null>(null);
  const [customOcrPrompt, setCustomOcrPrompt] = useState<string>(
    "تکایە ب وردی ناڤێ ماموستای، بابەت، و جهـێ پۆلان د هەر وانەیەکێ دا ب ڕێزبەندیا درست (وانا 1 تا 6) بێ خەلەتی دیار بکە."
  );

  // API Key Testing & Validation State
  const [keyValidating, setKeyValidating] = useState<boolean>(false);
  const [keyValidationStatus, setKeyValidationStatus] = useState<'valid' | 'invalid' | null>(null);
  const [keyValidationError, setKeyValidationError] = useState<string | null>(null);

  const testApiKey = async (keyToTest?: string) => {
    const k = keyToTest !== undefined ? keyToTest : userApiKey;
    setKeyValidating(true);
    setKeyValidationStatus(null);
    setKeyValidationError(null);
    try {
      let isSuccess = false;
      let errorMsg = "";

      // 1. Try server endpoint first (instantly bypassed if static host like GitHub Pages)
      try {
        const res = await fetchServerWithTimeout("/api/gemini/validate-key", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ customApiKey: k }),
        }, 1200);

        if (res.ok && res.headers.get("content-type")?.includes("application/json")) {
          const data = await res.json();
          if (data.valid) {
            setKeyValidationStatus('valid');
            return;
          } else {
            errorMsg = data.error || "کلیل خەلەتە یان چالاک نینە";
          }
        }
      } catch (serverErr) {
        // Server unavailable (e.g. GitHub Pages static host)
      }

      // 2. Client-side direct call
      try {
        await callClientGeminiValidate(k);
        setKeyValidationStatus('valid');
        return;
      } catch (clientErr: any) {
        errorMsg = clientErr?.message || errorMsg || "کلیل خەلەتە یان چالاک نینە";
      }

      setKeyValidationStatus('invalid');
      setKeyValidationError(errorMsg);
    } catch (err: any) {
      setKeyValidationStatus('invalid');
      setKeyValidationError(err?.message || "کێشەیەک لە پەیوەندی دروست بوو");
    } finally {
      setKeyValidating(false);
    }
  };

  // AI Timing Assistant State
  const [aiTimingPrompt, setAiTimingPrompt] = useState("");
  const [aiTimingLoading, setAiTimingLoading] = useState(false);
  const [aiTimingFeedback, setAiTimingFeedback] = useState<string | null>(null);

  // Time & Live Tracking State
  const [realTime, setRealTime] = useState(new Date());
  const [manualTimeStr, setManualTimeStr] = useState<string | null>(null);
  const [timeRemaining, setTimeRemaining] = useState<string>("");
  const [currentLiveSlot, setCurrentLiveSlot] = useState<{ slot: LessonSlot | null; status: string }>({
    slot: null,
    status: 'none',
  });
  const [nextLiveSlot, setNextLiveSlot] = useState<LessonSlot | null>(null);
  const [wakeLock, setWakeLock] = useState<any>(null);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);

  // Alarm & Timing Settings (Syncs with Firebase Firestore School Master Settings)
  const [alarmSettings, setAlarmSettings] = useState<AlarmSettings>(() => {
    try {
      const saved = localStorage.getItem('alarm_settings_v10');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed === 'object') {
          const mergedShifts: Record<string, ShiftType> = { ...DEFAULT_DAY_SHIFTS, ...(parsed.dayShifts || {}) };
          if ((parsed as any)._v10SunMonShiftMigrated !== true) {
            mergedShifts['ئێکشەمبی'] = 'evening';
            mergedShifts['دووشەمبی'] = 'evening';
            mergedShifts['سێشەمبی'] = 'morning';
            mergedShifts['چوارشەمبی'] = 'morning';
            mergedShifts['پێنچ شەمبی'] = 'morning';
          }
          return {
            ...DEFAULT_ALARM_SETTINGS,
            ...parsed,
            _v10SunMonShiftMigrated: true,
            dayShifts: mergedShifts,
            examSettings: { ...DEFAULT_ALARM_SETTINGS.examSettings, ...(parsed.examSettings || {}) }
          };
        }
      }
    } catch (e) {}
    return DEFAULT_ALARM_SETTINGS;
  });

  const [adminSavingSettings, setAdminSavingSettings] = useState<boolean>(false);
  const [adminSettingsSuccessMsg, setAdminSettingsSuccessMsg] = useState<string | null>(null);

  // Lockscreen Wallpaper Generator State
  const [showWallpaperModal, setShowWallpaperModal] = useState(false);
  const [wallpaperTheme, setWallpaperTheme] = useState<'indigo' | 'amoled' | 'emerald' | 'amber' | 'white'>('indigo');
  const [wallpaperMode, setWallpaperMode] = useState<'full' | 'today'>('full');
  const [wallpaperTopY, setWallpaperTopY] = useState<number>(380);
  const [wallpaperScale, setWallpaperScale] = useState<number>(1.0);
  const [wallpaperSpacing, setWallpaperSpacing] = useState<number>(20);
  const [wallpaperShowHeader, setWallpaperShowHeader] = useState<boolean>(true);
  const [wallpaperShowFooter, setWallpaperShowFooter] = useState<boolean>(true);
  const wallpaperCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Widget Studio State
  const [showWidgetModal, setShowWidgetModal] = useState(false);
  const [widgetStyle, setWidgetStyle] = useState<'current' | 'today' | 'bar' | 'week'>('current');
  const [widgetTheme, setWidgetTheme] = useState<'amoled' | 'glass' | 'indigo' | 'emerald'>('amoled');
  const [pipActive, setPipActive] = useState<boolean>(false);
  const widgetCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pipCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pipVideoRef = useRef<HTMLVideoElement | null>(null);

  // Multi-Teacher & Firestore Sync State (100% Offline Cached)
  const [allTeachersList, setAllTeachersList] = useState<TeacherTimetableDoc[]>(getInitialAllTeachersList);
  const [selectedTeacherId, setSelectedTeacherId] = useState<string>(() => localStorage.getItem('selected_teacher_id') || 'teacher_hussein');
  const [showTeacherSelectModal, setShowTeacherSelectModal] = useState<boolean>(() => !localStorage.getItem('selected_teacher_id'));
  const [teacherSearchTerm, setTeacherSearchTerm] = useState<string>('');
  const [selectedGradeFilter, setSelectedGradeFilter] = useState<string>('all');
  const [selectedSectionFilter, setSelectedSectionFilter] = useState<string>('all');


  // Top Header Quick Search & Mobile Drawer Navigation
  const [headerSearchQuery, setHeaderSearchQuery] = useState<string>('');
  const [showHeaderSearchResults, setShowHeaderSearchResults] = useState<boolean>(false);
  const [selectedLookupTeacher, setSelectedLookupTeacher] = useState<TeacherTimetableDoc | null>(null);
  const [showTeacherStatusModal, setShowTeacherStatusModal] = useState<boolean>(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState<boolean>(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState<boolean>(false);

  // Smart Period Swap Engine State
  const [showSwapModal, setShowSwapModal] = useState<boolean>(false);
  const [swapSourceDay, setSwapSourceDay] = useState<string>(DAYS[0]);
  const [swapSourceLessonIndex, setSwapSourceLessonIndex] = useState<number>(0);
  const [swapTargetLessonIndex, setSwapTargetLessonIndex] = useState<number>(1);
  const [swapSelectedGrade, setSwapSelectedGrade] = useState<string>('auto');
  const [swapSelectedSection, setSwapSelectedSection] = useState<string>('auto');
  const [swapSuggestions, setSwapSuggestions] = useState<SwapSuggestion[]>([]);
  const [swapLoading, setSwapLoading] = useState<boolean>(false);
  const [swapExecutingId, setSwapExecutingId] = useState<string | null>(null);

  // Admin Management & Mass Import/Export State
  const [showAdminModal, setShowAdminModal] = useState<boolean>(false);
  const [isAdminLoggedIn, setIsAdminLoggedIn] = useState<boolean>(false);
  const [adminPinInput, setAdminPinInput] = useState<string>('');
  const [adminPinError, setAdminPinError] = useState<string | null>(null);
  const [adminBatchPreview, setAdminBatchPreview] = useState<TeacherTimetableDoc[]>([]);
  const [adminBatchLoading, setAdminBatchLoading] = useState<boolean>(false);
  const [adminSuccessMsg, setAdminSuccessMsg] = useState<string | null>(null);
  const [adminCodeInput, setAdminCodeInput] = useState<string>('');
  const [adminImportTab, setAdminImportTab] = useState<'edit' | 'requests' | 'timings' | 'sections' | 'code' | 'file'>('edit');

  // Teacher Schedule Change Requests & Admin Review State
  const [changeRequests, setChangeRequests] = useState<ScheduleChangeRequest[]>([]);
  const [requestActionLoadingId, setRequestActionLoadingId] = useState<string | null>(null);
  const [teacherSubmittedStatus, setTeacherSubmittedStatus] = useState<string | null>(null);
  const [requestFilterStatus, setRequestFilterStatus] = useState<'all' | 'pending' | 'approved' | 'rejected'>('all');
  const [adminCustomSectionInput, setAdminCustomSectionInput] = useState<string>('');

  // Admin Direct Timetable Editor State
  const [adminEditingTeacher, setAdminEditingTeacher] = useState<TeacherTimetableDoc | null>(null);
  const [adminEditingSchedule, setAdminEditingSchedule] = useState<WeekSchedule | null>(null);
  const [adminEditingName, setAdminEditingName] = useState<string>('');
  const [adminEditingSubject, setAdminEditingSubject] = useState<string>('');
  const [adminSavingLoading, setAdminSavingLoading] = useState<boolean>(false);
  const [adminTeacherSearch, setAdminTeacherSearch] = useState<string>('');

  const toggleViewMode = () => setViewMode((prev) => (prev === 'modern' ? 'classic' : 'modern'));
  const currentDayData = schedule[activeDay] || schedule[DAYS[0]];


  const audioContextRef = useRef<AudioContext | null>(null);
  const currentSourceNodeRef = useRef<AudioBufferSourceNode | null>(null);
  const shouldStopRef = useRef<boolean>(false);
  const lastTriggeredRef = useRef<string>("");

  const getEffectiveTime = () => {
    if (manualTimeStr) {
      const [h, m] = manualTimeStr.split(':').map(Number);
      const d = new Date(realTime);
      d.setHours(h, m, 0, 0);
      return d;
    }
    return realTime;
  };

  const effectiveTime = getEffectiveTime();

  useEffect(() => {
    const timer = setInterval(() => {
      setRealTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // 1. Instant Restore from IndexedDB on Boot if larger offline set exists
  useEffect(() => {
    const restoreOfflineTeachersFromIDB = async () => {
      try {
        const idbData = await getBackupData(OFFLINE_TEACHERS_STORAGE_KEY);
        if (Array.isArray(idbData) && idbData.length > 0) {
          const reconciledIDB = idbData.map((t: TeacherTimetableDoc) => ({
            ...t,
            schedule: reconcileScheduleWithDayShifts(t.schedule, alarmSettings)
          }));
          setAllTeachersList((prev) => (reconciledIDB.length >= prev.length ? reconciledIDB : prev));
          try {
            localStorage.setItem(OFFLINE_TEACHERS_STORAGE_KEY, JSON.stringify(reconciledIDB));
          } catch (e) {}
        }
      } catch (err) {
        console.warn("Error restoring offline teachers from IndexedDB:", err);
      }
    };
    restoreOfflineTeachersFromIDB();
  }, []);

  // 1.5 Auto-Reconcile Cached Timetables with current day shifts and lesson timings
  useEffect(() => {
    setSchedule((prev) => {
      const reconciled = reconcileScheduleWithDayShifts(prev, alarmSettings);
      try {
        localStorage.setItem('timetable_data', JSON.stringify(reconciled));
        saveBackupData('timetable_data', reconciled);
      } catch (e) {}
      return reconciled;
    });

    setAllTeachersList((prevList) => {
      const updated = prevList.map((t) => ({
        ...t,
        schedule: reconcileScheduleWithDayShifts(t.schedule, alarmSettings),
      }));
      try {
        localStorage.setItem(OFFLINE_TEACHERS_STORAGE_KEY, JSON.stringify(updated));
        saveBackupData(OFFLINE_TEACHERS_STORAGE_KEY, updated);
      } catch (e) {}
      return updated;
    });
  }, [
    alarmSettings.dayShifts,
    alarmSettings.morningDuration,
    alarmSettings.eveningDuration,
    alarmSettings.morningStartTime,
    alarmSettings.eveningStartTime,
    alarmSettings.examSettings?.enabled
  ]);

  // 2. Real-time Firestore sync with dual persistent offline storage
  useEffect(() => {
    let unsub: (() => void) | null = null;
    try {
      unsub = onSnapshot(collection(db, TIMETABLES_COLLECTION), async (snapshot) => {
        const list: TeacherTimetableDoc[] = [];
        snapshot.forEach((docSnap) => {
          list.push({ id: docSnap.id, ...(docSnap.data() as any) });
        });

        if (list.length === 0) {
          // Seed default timetables if collection is empty
          await batchSaveTimetablesToFirestore(DEFAULT_SEED_TEACHERS);
          setAllTeachersList(DEFAULT_SEED_TEACHERS);
          try {
            localStorage.setItem(OFFLINE_TEACHERS_STORAGE_KEY, JSON.stringify(DEFAULT_SEED_TEACHERS));
            saveBackupData(OFFLINE_TEACHERS_STORAGE_KEY, DEFAULT_SEED_TEACHERS);
          } catch (e) {}
        } else {
          const reconciledList = list.map((t) => ({
            ...t,
            schedule: reconcileScheduleWithDayShifts(t.schedule, alarmSettings)
          }));
          setAllTeachersList(reconciledList);
          try {
            localStorage.setItem(OFFLINE_TEACHERS_STORAGE_KEY, JSON.stringify(reconciledList));
            saveBackupData(OFFLINE_TEACHERS_STORAGE_KEY, reconciledList);
          } catch (e) {
            saveBackupData(OFFLINE_TEACHERS_STORAGE_KEY, reconciledList);
          }
        }
      }, (err) => {
        console.warn("Firestore snapshot listener (offline mode active):", err);
      });
    } catch (e) {
      console.warn("Snapshot setup error:", e);
    }
    return () => { if (unsub) unsub(); };
  }, [alarmSettings.dayShifts]);

  // 3. Real-time Master School Settings Firestore Sync (Broadcast to Everyone)
  useEffect(() => {
    let unsubSettings: (() => void) | null = null;
    try {
      const settingsDocRef = doc(db, SCHOOL_SETTINGS_COLLECTION, SETTINGS_GLOBAL_DOC);
      unsubSettings = onSnapshot(settingsDocRef, (docSnap) => {
        if (docSnap.exists()) {
          const remoteData = docSnap.data() as Partial<AlarmSettings>;
          if (remoteData && typeof remoteData === 'object') {
            setAlarmSettings((prev) => {
              const merged: AlarmSettings = {
                ...prev,
                ...remoteData,
                customSections: remoteData.customSections || prev.customSections || STANDARD_SECTIONS,
                customSectionsCount: remoteData.customSectionsCount || prev.customSectionsCount || 7,
                dayShifts: { ...DEFAULT_DAY_SHIFTS, ...(remoteData.dayShifts || prev.dayShifts || {}) },
                examSettings: {
                  ...prev.examSettings,
                  ...(remoteData.examSettings || {})
                }
              };
              try {
                localStorage.setItem('alarm_settings_v10', JSON.stringify(merged));
                saveBackupData('alarm_settings_v10', merged);
              } catch (e) {}
              return merged;
            });
          }
        }
      }, (err) => {
        console.warn("School settings Firestore listener (offline fallback):", err);
      });
    } catch (e) {
      console.warn("Settings listener error:", e);
    }
    return () => { if (unsubSettings) unsubSettings(); };
  }, []);

  // 4. Real-time Teacher Schedule Change Requests Listener (For Admin Review & Sync)
  useEffect(() => {
    let unsubReqs: (() => void) | null = null;
    try {
      unsubReqs = onSnapshot(collection(db, SCHEDULE_CHANGE_REQUESTS_COLLECTION), (snapshot) => {
        const reqList: ScheduleChangeRequest[] = [];
        snapshot.forEach((docSnap) => {
          reqList.push({ id: docSnap.id, ...(docSnap.data() as any) });
        });
        reqList.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
        setChangeRequests(reqList);
      }, (err) => {
        console.warn("Change requests listener (offline mode active):", err);
      });
    } catch (e) {
      console.warn("Requests snapshot setup error:", e);
    }
    return () => { if (unsubReqs) unsubReqs(); };
  }, []);

  // Teacher Schedule Edit Flow: Instant Offline Save + Online Submission to Admin for Global Sync
  const handleTeacherSaveAndSubmitChange = async (updatedSchedule: WeekSchedule) => {
    // 1. Instantly save locally on this device as offline
    setSchedule(updatedSchedule);
    localStorage.setItem('timetable_data', JSON.stringify(updatedSchedule));
    saveBackupData('timetable_data', updatedSchedule);
    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 3000);

    // 2. Compute differences compared to the official timetable in allTeachersList
    const officialDoc = allTeachersList.find(t => t.id === selectedTeacherId || t.teacherName === teacherName);
    const officialSchedule = officialDoc?.schedule || INITIAL_SCHEDULE;

    const changesSummary: string[] = [];
    DAYS.forEach(day => {
      const newSlots = updatedSchedule[day]?.slots || [];
      const oldSlots = officialSchedule[day]?.slots || [];
      newSlots.forEach((slot, i) => {
        const oldSlot = oldSlots[i];
        if (oldSlot && (oldSlot.className !== slot.className || oldSlot.subject !== slot.subject)) {
          changesSummary.push(`ڕۆژا ${day} - وانا ${i + 1}: [${oldSlot.className || 'بەتاڵ'}] ⬅️ [${slot.className || 'بەتاڵ'}]`);
        }
      });
    });

    if (changesSummary.length === 0) {
      changesSummary.push(`دەستکاریا کات یان وانان لە لایەن مامۆستا ${teacherName}`);
    }

    // 3. Online submit proposal to admin
    const reqId = `req_${(selectedTeacherId || 'teacher').replace(/\s+/g, '_')}_${Date.now()}`;
    const changeReq: ScheduleChangeRequest = {
      id: reqId,
      teacherId: selectedTeacherId || 'teacher_hussein',
      teacherName: teacherName,
      subject: teacherSubject,
      requestedSchedule: updatedSchedule,
      previousSchedule: officialSchedule,
      changesSummary,
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    const sent = await submitScheduleChangeRequest(changeReq);
    if (sent) {
      setTeacherSubmittedStatus(`✅ دەستکاریا تە ل سەر مۆبایلا تە خەزن بوو (ئۆفلاین)! داخوازی ئۆنلاین بۆ ئەدمینی هاتە هنارتن دا پەسەند بکەت و ل هەمی جهـان بەڵاڤ بکەت.`);
    } else {
      setTeacherSubmittedStatus(`✅ دەستکاریا تە بە سەرکەوتوویی ئۆفلاین خەزن بوو.`);
    }
    setTimeout(() => setTeacherSubmittedStatus(null), 8000);
  };

  // Admin Approve Teacher Request: Updates Master Timetables in Firestore & Syncs to All Devices
  const handleAdminApproveChangeRequest = async (req: ScheduleChangeRequest) => {
    setRequestActionLoadingId(req.id);
    try {
      await saveTimetableToFirestore(req.teacherId, {
        id: req.teacherId,
        teacherName: req.teacherName,
        subject: req.subject,
        schedule: req.requestedSchedule,
        updatedAt: new Date().toISOString()
      });

      await updateScheduleChangeRequestStatus(req.id, 'approved', 'پەسەندکرا لە لایەن ئەدمین');

      setAllTeachersList((prev) => {
        const updated = prev.map(t => {
          if (t.id === req.teacherId || t.teacherName === req.teacherName) {
            return { ...t, schedule: req.requestedSchedule, updatedAt: new Date().toISOString() };
          }
          return t;
        });
        try {
          localStorage.setItem(OFFLINE_TEACHERS_STORAGE_KEY, JSON.stringify(updated));
          saveBackupData(OFFLINE_TEACHERS_STORAGE_KEY, updated);
        } catch (e) {}
        return updated;
      });

      if (selectedTeacherId === req.teacherId) {
        setSchedule(req.requestedSchedule);
        localStorage.setItem('timetable_data', JSON.stringify(req.requestedSchedule));
        saveBackupData('timetable_data', req.requestedSchedule);
      }

      alert(`🎉 داخوازییا مامۆستا [${req.teacherName}] ب سەرکەفتیانە هاتە قبوولکرن و ل هەموو مۆبایل و قوتابخانێ بەڵاڤ بوو!`);
    } catch (err: any) {
      alert("خەلەتی لە پەسەندکردندا: " + err.message);
    } finally {
      setRequestActionLoadingId(null);
    }
  };

  // Admin Reject Teacher Request
  const handleAdminRejectChangeRequest = async (req: ScheduleChangeRequest, notes: string = '') => {
    setRequestActionLoadingId(req.id);
    try {
      await updateScheduleChangeRequestStatus(req.id, 'rejected', notes || 'ڕەتکرایەوە لە لایەن ئەدمین');
      alert(`داخوازییا مامۆستا [${req.teacherName}] هاتە ڕەتکرن.`);
    } catch (err: any) {
      alert("خەلەتی: " + err.message);
    } finally {
      setRequestActionLoadingId(null);
    }
  };

  const handleAdminSaveMasterSettings = async (overrideSettings?: AlarmSettings) => {
    const targetToSave = overrideSettings || alarmSettings;
    setAdminSavingSettings(true);
    setAdminSettingsSuccessMsg(null);
    try {
      await saveSchoolSettingsToFirestore(targetToSave);
      setAlarmSettings(targetToSave);
      try {
        localStorage.setItem('alarm_settings_v10', JSON.stringify(targetToSave));
        saveBackupData('alarm_settings_v10', targetToSave);
      } catch (e) {}
      applySettingsToSchedule(targetToSave);
      setAdminSettingsSuccessMsg("✅ وەختێت دەوامێ، خولەکێن وانان، جەرەس، انتیحانێ و پیتێن هۆبان د داتابەیسدا هاتنە پاشکەفتن و بۆ هەمووان بەڵاڤبوون!");
      setTimeout(() => setAdminSettingsSuccessMsg(null), 6000);
    } catch (err: any) {
      alert("خەلەتی لە پاشکەفتنی وەختەکان: " + err.message);
    } finally {
      setAdminSavingSettings(false);
    }
  };


  // Sync selected teacher profile from allTeachersList
  useEffect(() => {
    if (allTeachersList.length > 0 && selectedTeacherId) {
      const activeDoc = allTeachersList.find(t => t.id === selectedTeacherId || t.teacherName === selectedTeacherId);
      if (activeDoc) {
        const reconciledSched = reconcileScheduleWithDayShifts(activeDoc.schedule, alarmSettings);
        setTeacherName(activeDoc.teacherName);
        setTeacherSubject(activeDoc.subject || 'کیمیا');
        setSchedule(reconciledSched);
        localStorage.setItem('timetable_data', JSON.stringify(reconciledSched));
        localStorage.setItem('teacher_name', activeDoc.teacherName);
        localStorage.setItem('teacher_subject', activeDoc.subject || 'کیمیا');
        saveBackupData('timetable_data', reconciledSched);
        saveBackupData('teacher_name', activeDoc.teacherName);
        saveBackupData('teacher_subject', activeDoc.subject || 'کیمیا');
      }
    }
  }, [allTeachersList, selectedTeacherId, alarmSettings.dayShifts]);

  const selectTeacherProfile = (teacherDoc: TeacherTimetableDoc) => {
    const reconciledSched = reconcileScheduleWithDayShifts(teacherDoc.schedule, alarmSettings);
    setSelectedTeacherId(teacherDoc.id);
    setTeacherName(teacherDoc.teacherName);
    setTeacherSubject(teacherDoc.subject || 'کیمیا');
    setSchedule(reconciledSched);
    localStorage.setItem('selected_teacher_id', teacherDoc.id);
    localStorage.setItem('teacher_name', teacherDoc.teacherName);
    localStorage.setItem('teacher_subject', teacherDoc.subject || 'کیمیا');
    localStorage.setItem('timetable_data', JSON.stringify(reconciledSched));
    saveBackupData('selected_teacher_id', teacherDoc.id);
    saveBackupData('teacher_name', teacherDoc.teacherName);
    saveBackupData('teacher_subject', teacherDoc.subject || 'کیمیا');
    saveBackupData('timetable_data', reconciledSched);
    setShowTeacherSelectModal(false);
  };

  // Smart Period Swap Search Logic (Strict Grade & Section Matching, 1-to-4 Teacher Multi-Step Chain Swaps)
  const findSwapSuggestions = () => {
    if (!allTeachersList.length || !selectedTeacherId) return;
    setSwapLoading(true);

    const activeDoc = allTeachersList.find(t => t.id === selectedTeacherId || t.teacherName === selectedTeacherId);
    if (!activeDoc) {
      setSwapLoading(false);
      return;
    }

    const teacherAName = activeDoc.teacherName;
    const teacherASubject = activeDoc.subject || 'کیمیا';
    const daySched = activeDoc.schedule[swapSourceDay];
    if (!daySched || !daySched.slots) {
      setSwapLoading(false);
      return;
    }

    const sourceSlot = daySched.slots[swapSourceLessonIndex];
    const rawClassToMove = sourceSlot?.className || 'بێ وانە';

    if (rawClassToMove === 'بێ وانە' || rawClassToMove === 'فەراغ') {
      setSwapSuggestions([]);
      setSwapLoading(false);
      return;
    }

    const parsedSource = parseClassAndSection(rawClassToMove);
    const targetGrade = (swapSelectedGrade && swapSelectedGrade !== 'auto') 
      ? (swapSelectedGrade.startsWith('پۆلا') ? swapSelectedGrade : `پۆلا ${swapSelectedGrade}`)
      : parsedSource.grade;

    const targetSection = (swapSelectedSection && swapSelectedSection !== 'auto')
      ? (swapSelectedSection.startsWith('هۆبەیا') ? swapSelectedSection : `هۆبەیا (${swapSelectedSection})`)
      : parsedSource.section;

    const suggestions: SwapSuggestion[] = [];

    // LEVEL 1: 1-Teacher Direct Swaps
    allTeachersList.forEach((tB) => {
      if (tB.teacherName === teacherAName) return;
      const bDay = tB.schedule[swapSourceDay];
      if (!bDay || !bDay.slots) return;

      const bTargetSlot = bDay.slots[swapTargetLessonIndex];
      const bSourceSlot = bDay.slots[swapSourceLessonIndex];

      if (bTargetSlot && bTargetSlot.className && bTargetSlot.className !== 'بێ وانە') {
        const parsedBTarget = parseClassAndSection(bTargetSlot.className);
        
        if (parsedBTarget.grade === targetGrade && parsedBTarget.section === targetSection) {
          if (bSourceSlot && (bSourceSlot.className === 'بێ وانە' || !bSourceSlot.className || bSourceSlot.className === 'فەراغ')) {
            suggestions.push({
              id: `swap_direct_${tB.id}_${Math.random().toString(36).substring(2, 6)}`,
              type: 'direct',
              teacherCount: 2,
              dayName: swapSourceDay,
              sourceLessonIndex: swapSourceLessonIndex,
              targetLessonIndex: swapTargetLessonIndex,
              teacherA: teacherAName,
              classNameToMove: rawClassToMove,
              partnerTeacher1: tB.teacherName,
              partnerSubject1: tB.subject || 'بێ بابەت',
              partnerClass1: bTargetSlot.className,
              steps: [
                {
                  stepNumber: 1,
                  teacherName: tB.teacherName,
                  subject: tB.subject || 'مامۆستا',
                  fromLesson: swapTargetLessonIndex + 1,
                  toLesson: swapSourceLessonIndex + 1,
                  className: `${targetGrade} — ${targetSection}`,
                  actionKurdish: `م. [${tB.teacherName} - ${tB.subject || ''}] لە وانەی ${swapTargetLessonIndex + 1}دا پۆلا (${targetGrade} — ${targetSection}) بەجێدەهێڵێت و لە وانەی ${swapSourceLessonIndex + 1}دا بەتاڵە.`
                },
                {
                  stepNumber: 2,
                  teacherName: teacherAName,
                  subject: teacherASubject,
                  fromLesson: swapSourceLessonIndex + 1,
                  toLesson: swapTargetLessonIndex + 1,
                  className: `${targetGrade} — ${targetSection}`,
                  actionKurdish: `پاشان [تۆ - ${teacherAName}] وانەکەت لە وانەی ${swapSourceLessonIndex + 1}دا دەگوازیتەوە بۆ وانەی ${swapTargetLessonIndex + 1} د پۆلا (${targetGrade} — ${targetSection}) دا!`
                }
              ],
              detailsKurdish: `⚡ گۆڕینەوەی ڕاستەوخۆی 1 مامۆستا (نەفسی پۆل و هەمان هۆبە):`
            });
          }
        }
      }
    });

    // LEVEL 2: 2-Teacher Chain Swaps (3-Way)
    if (suggestions.length === 0) {
      allTeachersList.forEach((tB) => {
        if (tB.teacherName === teacherAName) return;
        const bDay = tB.schedule[swapSourceDay];
        if (!bDay || !bDay.slots) return;

        const bTargetSlot = bDay.slots[swapTargetLessonIndex];
        const bSourceSlot = bDay.slots[swapSourceLessonIndex];

        if (bTargetSlot && bTargetSlot.className && bTargetSlot.className !== 'بێ وانە') {
          const parsedBTarget = parseClassAndSection(bTargetSlot.className);
          
          if (parsedBTarget.grade === targetGrade && parsedBTarget.section === targetSection) {
            if (bSourceSlot && bSourceSlot.className !== 'بێ وانە' && bSourceSlot.className !== 'فەراغ') {
              const classBInSource = bSourceSlot.className;

              allTeachersList.forEach((tC) => {
                if (tC.teacherName === teacherAName || tC.teacherName === tB.teacherName) return;
                const cDay = tC.schedule[swapSourceDay];
                if (!cDay || !cDay.slots) return;

                const cSourceSlot = cDay.slots[swapSourceLessonIndex];
                const cTargetSlot = cDay.slots[swapTargetLessonIndex];

                if (cTargetSlot && cTargetSlot.className === classBInSource && cSourceSlot && (cSourceSlot.className === 'بێ وانە' || !cSourceSlot.className || cSourceSlot.className === 'فەراغ')) {
                  suggestions.push({
                    id: `swap_chain_${tB.id}_${tC.id}_${Math.random().toString(36).substring(2, 6)}`,
                    type: 'chain',
                    teacherCount: 3,
                    dayName: swapSourceDay,
                    sourceLessonIndex: swapSourceLessonIndex,
                    targetLessonIndex: swapTargetLessonIndex,
                    teacherA: teacherAName,
                    classNameToMove: rawClassToMove,
                    partnerTeacher1: tB.teacherName,
                    partnerSubject1: tB.subject || '',
                    partnerClass1: bTargetSlot.className,
                    partnerTeacher2: tC.teacherName,
                    partnerSubject2: tC.subject || '',
                    partnerClass2: classBInSource,
                    steps: [
                      {
                        stepNumber: 1,
                        teacherName: tC.teacherName,
                        subject: tC.subject || 'مامۆستا',
                        fromLesson: swapTargetLessonIndex + 1,
                        toLesson: swapSourceLessonIndex + 1,
                        className: classBInSource,
                        actionKurdish: `1. م. [${tC.teacherName}] دەچێتە پۆلا (${classBInSource}) لە وانەی ${swapSourceLessonIndex + 1}دا چونکە لێرە فەراغە.`
                      },
                      {
                        stepNumber: 2,
                        teacherName: tB.teacherName,
                        subject: tB.subject || 'مامۆستا',
                        fromLesson: swapSourceLessonIndex + 1,
                        toLesson: swapTargetLessonIndex + 1,
                        className: `${targetGrade} — ${targetSection}`,
                        actionKurdish: `2. م. [${tB.teacherName}] پۆلا (${targetGrade} — ${targetSection}) بەجێدەهێڵێت لە وانەی ${swapTargetLessonIndex + 1}دا و دەچێتە شوێنی م. [${tC.teacherName}] لە وانەی ${swapSourceLessonIndex + 1}دا.`
                      },
                      {
                        stepNumber: 3,
                        teacherName: teacherAName,
                        subject: teacherASubject,
                        fromLesson: swapSourceLessonIndex + 1,
                        toLesson: swapTargetLessonIndex + 1,
                        className: `${targetGrade} — ${targetSection}`,
                        actionKurdish: `3. پاشان [تۆ - ${teacherAName}] دەچییە شوێنی م. [${tB.teacherName}] د پۆلا (${targetGrade} — ${targetSection}) دا لە وانەی ${swapTargetLessonIndex + 1}دا!`
                      }
                    ],
                    detailsKurdish: `🔗 گۆڕینەوەی زنجیرەیی 3 مامۆستایی (نەفسی پۆل و هۆبە):`
                  });
                }
              });
            }
          }
        }
      });
    }

    // LEVEL 3: 3-Teacher & 4-Teacher Multi-Chain Swaps
    if (suggestions.length === 0) {
      allTeachersList.forEach((tB) => {
        if (tB.teacherName === teacherAName) return;
        const bDay = tB.schedule[swapSourceDay];
        if (!bDay || !bDay.slots) return;

        const bTargetSlot = bDay.slots[swapTargetLessonIndex];
        const bSourceSlot = bDay.slots[swapSourceLessonIndex];

        if (bTargetSlot && bTargetSlot.className && bTargetSlot.className !== 'بێ وانە') {
          const parsedBTarget = parseClassAndSection(bTargetSlot.className);
          if (parsedBTarget.grade === targetGrade && parsedBTarget.section === targetSection) {
            const classBInSource = bSourceSlot?.className;
            if (classBInSource && classBInSource !== 'بێ وانە') {
              allTeachersList.forEach((tC) => {
                if (tC.teacherName === teacherAName || tC.teacherName === tB.teacherName) return;
                const cDay = tC.schedule[swapSourceDay];
                if (!cDay || !cDay.slots) return;

                const cSourceSlot = cDay.slots[swapSourceLessonIndex];
                const classCInSource = cSourceSlot?.className;

                if (classCInSource && classCInSource !== 'بێ وانە') {
                  allTeachersList.forEach((tD) => {
                    if (tD.teacherName === teacherAName || tD.teacherName === tB.teacherName || tD.teacherName === tC.teacherName) return;
                    const dDay = tD.schedule[swapSourceDay];
                    if (!dDay || !dDay.slots) return;

                    const dSourceSlot = dDay.slots[swapSourceLessonIndex];
                    const dTargetSlot = dDay.slots[swapTargetLessonIndex];

                    if (dTargetSlot && dTargetSlot.className === classCInSource && dSourceSlot && (dSourceSlot.className === 'بێ وانە' || !dSourceSlot.className || dSourceSlot.className === 'فەراغ')) {
                      suggestions.push({
                        id: `swap_multichain_${tB.id}_${tC.id}_${tD.id}_${Math.random().toString(36).substring(2, 6)}`,
                        type: 'multi_chain',
                        teacherCount: 4,
                        dayName: swapSourceDay,
                        sourceLessonIndex: swapSourceLessonIndex,
                        targetLessonIndex: swapTargetLessonIndex,
                        teacherA: teacherAName,
                        classNameToMove: rawClassToMove,
                        partnerTeacher1: tB.teacherName,
                        partnerSubject1: tB.subject || '',
                        partnerClass1: bTargetSlot.className,
                        partnerTeacher2: tC.teacherName,
                        partnerSubject2: tC.subject || '',
                        partnerClass2: classBInSource,
                        partnerTeacher3: tD.teacherName,
                        partnerSubject3: tD.subject || '',
                        partnerClass3: classCInSource,
                        steps: [
                          {
                            stepNumber: 1,
                            teacherName: tD.teacherName,
                            subject: tD.subject || 'مامۆستا',
                            fromLesson: swapTargetLessonIndex + 1,
                            toLesson: swapSourceLessonIndex + 1,
                            className: classCInSource,
                            actionKurdish: `1. م. [${tD.teacherName}] بچێتە شوێنی م. [${tC.teacherName}] بۆ پۆلا (${classCInSource}) لە وانەی ${swapSourceLessonIndex + 1}دا.`
                          },
                          {
                            stepNumber: 2,
                            teacherName: tC.teacherName,
                            subject: tC.subject || 'مامۆستا',
                            fromLesson: swapSourceLessonIndex + 1,
                            toLesson: swapTargetLessonIndex + 1,
                            className: classBInSource,
                            actionKurdish: `2. م. [${tC.teacherName}] بچێتە شوێنی م. [${tB.teacherName}] بۆ پۆلا (${classBInSource}) لە وانەی ${swapSourceLessonIndex + 1}دا.`
                          },
                          {
                            stepNumber: 3,
                            teacherName: tB.teacherName,
                            subject: tB.subject || 'مامۆستا',
                            fromLesson: swapSourceLessonIndex + 1,
                            toLesson: swapTargetLessonIndex + 1,
                            className: `${targetGrade} — ${targetSection}`,
                            actionKurdish: `3. م. [${tB.teacherName}] پۆلا (${targetGrade} — ${targetSection}) بەجێدەهێڵێت لە وانەی ${swapTargetLessonIndex + 1}دا.`
                          },
                          {
                            stepNumber: 4,
                            teacherName: teacherAName,
                            subject: teacherASubject,
                            fromLesson: swapSourceLessonIndex + 1,
                            toLesson: swapTargetLessonIndex + 1,
                            className: `${targetGrade} — ${targetSection}`,
                            actionKurdish: `4. پاشان [تۆ - ${teacherAName}] دەچییە شوێنی م. [${tB.teacherName}] د پۆلا (${targetGrade} — ${targetSection}) دا لە وانەی ${swapTargetLessonIndex + 1}دا!`
                          }
                        ],
                        detailsKurdish: `🧩 گۆڕینەوەی چوارچێوەیی 4 مامۆستایی (Multi-Teacher Step Swap):`
                      });
                    }
                  });
                }
              });
            }
          }
        }
      });
    }

    setSwapSuggestions(suggestions);
    setSwapLoading(false);
  };

  // Instant offline auto-search when swap modal settings change
  useEffect(() => {
    if (showSwapModal) {
      findSwapSuggestions();
    }
  }, [showSwapModal, swapSourceDay, swapSourceLessonIndex, swapTargetLessonIndex, swapSelectedGrade, swapSelectedSection, allTeachersList]);

  const applySwapToDatabase = async (suggestion: SwapSuggestion) => {
    setSwapExecutingId(suggestion.id);
    try {
      const activeDoc = allTeachersList.find(t => t.id === selectedTeacherId || t.teacherName === selectedTeacherId);
      const partner1Doc = allTeachersList.find(t => t.teacherName === suggestion.partnerTeacher1);
      const partner2Doc = suggestion.partnerTeacher2 ? allTeachersList.find(t => t.teacherName === suggestion.partnerTeacher2) : null;
      const partner3Doc = suggestion.partnerTeacher3 ? allTeachersList.find(t => t.teacherName === suggestion.partnerTeacher3) : null;

      if (!activeDoc || !partner1Doc) {
        alert("مامۆستا دۆزینەوە لە داتابێسدا نەبوو!");
        return;
      }

      const dayName = suggestion.dayName;
      const sIdx = suggestion.sourceLessonIndex;
      const tIdx = suggestion.targetLessonIndex;

      // Swap Teacher A
      const newActiveSchedule = JSON.parse(JSON.stringify(activeDoc.schedule));
      const tempA = newActiveSchedule[dayName].slots[sIdx].className;
      newActiveSchedule[dayName].slots[sIdx].className = newActiveSchedule[dayName].slots[tIdx].className;
      newActiveSchedule[dayName].slots[tIdx].className = tempA;
      await saveTimetableToFirestore(activeDoc.id, { schedule: newActiveSchedule });

      // Swap Teacher B
      const newPartner1Schedule = JSON.parse(JSON.stringify(partner1Doc.schedule));
      const tempB = newPartner1Schedule[dayName].slots[sIdx].className;
      newPartner1Schedule[dayName].slots[sIdx].className = newPartner1Schedule[dayName].slots[tIdx].className;
      newPartner1Schedule[dayName].slots[tIdx].className = tempB;
      await saveTimetableToFirestore(partner1Doc.id, { schedule: newPartner1Schedule });

      // Swap Teacher C if present
      let newPartner2Schedule: any = null;
      if (partner2Doc) {
        newPartner2Schedule = JSON.parse(JSON.stringify(partner2Doc.schedule));
        const tempC = newPartner2Schedule[dayName].slots[sIdx].className;
        newPartner2Schedule[dayName].slots[sIdx].className = newPartner2Schedule[dayName].slots[tIdx].className;
        newPartner2Schedule[dayName].slots[tIdx].className = tempC;
        await saveTimetableToFirestore(partner2Doc.id, { schedule: newPartner2Schedule });
      }

      // Swap Teacher D if present
      let newPartner3Schedule: any = null;
      if (partner3Doc) {
        newPartner3Schedule = JSON.parse(JSON.stringify(partner3Doc.schedule));
        const tempD = newPartner3Schedule[dayName].slots[sIdx].className;
        newPartner3Schedule[dayName].slots[sIdx].className = newPartner3Schedule[dayName].slots[tIdx].className;
        newPartner3Schedule[dayName].slots[tIdx].className = tempD;
        await saveTimetableToFirestore(partner3Doc.id, { schedule: newPartner3Schedule });
      }

      setSchedule(newActiveSchedule);
      localStorage.setItem('timetable_data', JSON.stringify(newActiveSchedule));
      saveBackupData('timetable_data', newActiveSchedule);

      setAllTeachersList((prev) => {
        const updated = prev.map(t => {
          if (t.id === activeDoc.id) return { ...t, schedule: newActiveSchedule };
          if (t.id === partner1Doc.id) return { ...t, schedule: newPartner1Schedule };
          if (partner2Doc && t.id === partner2Doc.id) return { ...t, schedule: newPartner2Schedule };
          if (partner3Doc && t.id === partner3Doc.id) return { ...t, schedule: newPartner3Schedule };
          return t;
        });
        try {
          localStorage.setItem(OFFLINE_TEACHERS_STORAGE_KEY, JSON.stringify(updated));
          saveBackupData(OFFLINE_TEACHERS_STORAGE_KEY, updated);
        } catch (e) {}
        return updated;
      });

      alert(`🎉 گۆڕینەوەی زنجیرەیی دناڤبەرا ${suggestion.teacherCount} مامۆستایان دا ب سەرکەفتیانە جێبەجێکرا و ئۆفلاین خەزن بوو!`);
      setShowSwapModal(false);
    } catch (err: any) {
      alert("خەلەتی: " + err.message);
    } finally {
      setSwapExecutingId(null);
    }
  };

  // Export All Timetables as JSON Backup File
  const handleExportAllJson = () => {
    const dataStr = JSON.stringify(allTeachersList, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `all_school_timetables_backup_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Admin Batch Upload (Code/JSON, Images, PDFs)
  const handleImportCodeOrFile = async (fileInput?: File) => {
    setAdminBatchLoading(true);
    setAdminSuccessMsg(null);
    try {
      let parsedTeachers: TeacherTimetableDoc[] = [];

      if (adminImportTab === 'code' && adminCodeInput.trim()) {
        const raw = JSON.parse(adminCodeInput.trim());
        const arr = Array.isArray(raw) ? raw : [raw];
        parsedTeachers = arr.map((item: any) => ({
          id: item.id || `teacher_${(item.teacherName || 'مامۆستا').replace(/\s+/g, '_')}_${Math.random().toString(36).substring(2, 6)}`,
          teacherName: item.teacherName || 'مامۆستای نەناسراو',
          subject: item.subject || 'گشتی',
          lessonCountPerDay: item.lessonCountPerDay || 6,
          schedule: item.schedule || INITIAL_SCHEDULE,
          notes: item.notes || 'کۆدی سەرەکی',
          updatedAt: new Date().toISOString()
        }));
      } else if (fileInput) {
        if (fileInput.name.endsWith('.json')) {
          const text = await fileInput.text();
          const raw = JSON.parse(text);
          const arr = Array.isArray(raw) ? raw : [raw];
          parsedTeachers = arr.map((item: any) => ({
            id: item.id || `teacher_${(item.teacherName || 'مامۆستا').replace(/\s+/g, '_')}_${Math.random().toString(36).substring(2, 6)}`,
            teacherName: item.teacherName || 'مامۆستای نەناسراو',
            subject: item.subject || 'گشتی',
            lessonCountPerDay: item.lessonCountPerDay || 6,
            schedule: item.schedule || INITIAL_SCHEDULE,
            notes: item.notes || 'فایلی JSON',
            updatedAt: new Date().toISOString()
          }));
        } else {
          // Process Image or PDF via Gemini OCR batch extraction
          const reader = new FileReader();
          const base64: string = await new Promise((resolve) => {
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(fileInput);
          });
          const mime = fileInput.type || "image/jpeg";
          const extracted = await callClientGeminiExtract(userApiKey, base64, mime, "Extract ALL teacher timetables from this document into array");
          
          if (extracted) {
            const arr = Array.isArray(extracted) ? extracted : [extracted];
            parsedTeachers = arr.map((item: any) => ({
              id: `teacher_${(item.teacherName || 'مامۆستا').replace(/\s+/g, '_')}_${Math.random().toString(36).substring(2, 6)}`,
              teacherName: item.teacherName || 'مامۆستا',
              subject: item.subject || 'کیمیا',
              lessonCountPerDay: item.lessonCountPerDay || 6,
              schedule: item.days ? parseDaysArrayToSchedule(item.days) : INITIAL_SCHEDULE,
              notes: 'دهێنراوە ب ڕێگەی Gemini AI',
              updatedAt: new Date().toISOString()
            }));
          }
        }
      }

      setAdminBatchPreview(parsedTeachers);
      setAdminSuccessMsg(`🎉 ${parsedTeachers.length} جەتوەلی مامۆستایان ئامادەکران بۆ پێداچوونەوە و بەڵاڤکرن!`);
    } catch (e: any) {
      alert("خەلەتی لە داغڵکردندا: " + e.message);
    } finally {
      setAdminBatchLoading(false);
    }
  };

  const parseDaysArrayToSchedule = (daysArr: any[]): WeekSchedule => {
    const newSchedule: WeekSchedule = {};
    DAYS.forEach((dayName) => {
      const match = daysArr.find((d: any) => d.dayName?.includes(dayName) || dayName.includes(d.dayName));
      const rawLessons = match?.lessons || [];
      newSchedule[dayName] = {
        dayName,
        shift: match?.shift || 'morning',
        slots: generateSlotsForDay(match?.shift || 'morning', rawLessons, alarmSettings)
      };
    });
    return newSchedule;
  };

  const handlePublishAdminBatch = async () => {
    if (!adminBatchPreview.length) return;
    setAdminBatchLoading(true);
    try {
      await batchSaveTimetablesToFirestore(adminBatchPreview);
      setAllTeachersList((prev) => {
        const updatedList = [...prev];
        adminBatchPreview.forEach((incoming) => {
          const idx = updatedList.findIndex(t => t.id === incoming.id || t.teacherName === incoming.teacherName);
          if (idx >= 0) updatedList[idx] = incoming;
          else updatedList.push(incoming);
        });
        try {
          localStorage.setItem(OFFLINE_TEACHERS_STORAGE_KEY, JSON.stringify(updatedList));
          saveBackupData(OFFLINE_TEACHERS_STORAGE_KEY, updatedList);
        } catch (e) {}
        return updatedList;
      });
      setAdminSuccessMsg(`🎉 هەموو ${adminBatchPreview.length} جەتوەلەکە ب سەرکەفتیانە بەڵاڤبوون بۆ هەموو مۆبایلەکان و ئۆفلاین خەزن کران!`);
      setAdminBatchPreview([]);
      setAdminCodeInput('');
    } catch (e: any) {
      alert("خەلەتی لە بەڵاڤکرندا: " + e.message);
    } finally {
      setAdminBatchLoading(false);
    }
  };

  const handleAdminStartEditTeacher = (tDoc: TeacherTimetableDoc) => {
    setAdminEditingTeacher(tDoc);
    setAdminEditingName(tDoc.teacherName);
    setAdminEditingSubject(tDoc.subject || 'کیمیا');
    setAdminEditingSchedule(JSON.parse(JSON.stringify(tDoc.schedule)));
  };

  const handleAdminUpdateEditingCell = (dayName: string, slotIndex: number, newClass: string) => {
    if (!adminEditingSchedule) return;
    setAdminEditingSchedule((prev) => {
      if (!prev) return prev;
      const updated = JSON.parse(JSON.stringify(prev));
      if (updated[dayName] && updated[dayName].slots && updated[dayName].slots[slotIndex]) {
        updated[dayName].slots[slotIndex].className = newClass;
      }
      return updated;
    });
  };

  const handleAdminSaveTeacherEdit = async () => {
    if (!adminEditingTeacher || !adminEditingSchedule) return;
    setAdminSavingLoading(true);
    try {
      const updatedDoc: TeacherTimetableDoc = {
        ...adminEditingTeacher,
        teacherName: adminEditingName.trim() || adminEditingTeacher.teacherName,
        subject: adminEditingSubject.trim() || adminEditingTeacher.subject || 'گشتی',
        schedule: adminEditingSchedule,
        updatedAt: new Date().toISOString()
      };

      await saveTimetableToFirestore(updatedDoc.id, updatedDoc);

      setAllTeachersList((prev) => {
        const updatedList = prev.map(t => t.id === updatedDoc.id ? updatedDoc : t);
        try {
          localStorage.setItem(OFFLINE_TEACHERS_STORAGE_KEY, JSON.stringify(updatedList));
          saveBackupData(OFFLINE_TEACHERS_STORAGE_KEY, updatedList);
        } catch (e) {}
        return updatedList;
      });

      if (selectedTeacherId === updatedDoc.id || selectedTeacherId === adminEditingTeacher.teacherName) {
        setTeacherName(updatedDoc.teacherName);
        setTeacherSubject(updatedDoc.subject);
        setSchedule(updatedDoc.schedule);
        localStorage.setItem('teacher_name', updatedDoc.teacherName);
        localStorage.setItem('teacher_subject', updatedDoc.subject);
        localStorage.setItem('timetable_data', JSON.stringify(updatedDoc.schedule));
        saveBackupData('teacher_name', updatedDoc.teacherName);
        saveBackupData('teacher_subject', updatedDoc.subject);
        saveBackupData('timetable_data', updatedDoc.schedule);
      }

      alert(`🎉 دەستکاری و تەعدیلا جەتوەلا [${updatedDoc.teacherName}] ب سەرکەفتیانە پاشکەفت بوو و ئۆفلاینیش خەزن بوو!`);
      setAdminEditingTeacher(null);
    } catch (err: any) {
      alert("خەلەتی لە پاراستندا: " + err.message);
    } finally {
      setAdminSavingLoading(false);
    }
  };

  const handleAdminDeleteTeacher = async (tDoc: TeacherTimetableDoc) => {
    if (window.confirm(`ئایا دڵنیای لە سڕینەوەی جەتوەلی مامۆستا [${tDoc.teacherName}] لە داتابێسی قوتابخانێدا؟`)) {
      try {
        await deleteTimetableFromFirestore(tDoc.id);
        setAllTeachersList((prev) => {
          const updatedList = prev.filter(t => t.id !== tDoc.id);
          try {
            localStorage.setItem(OFFLINE_TEACHERS_STORAGE_KEY, JSON.stringify(updatedList));
            saveBackupData(OFFLINE_TEACHERS_STORAGE_KEY, updatedList);
          } catch (e) {}
          return updatedList;
        });
        alert(`جەتوەلی [${tDoc.teacherName}] سڕایەوە!`);
      } catch (e: any) {
        alert("خەلەتی لە سڕینەوەدا: " + e.message);
      }
    }
  };

  const handleAdminAddNewTeacher = () => {
    const newId = `teacher_${Math.random().toString(36).substring(2, 8)}`;
    const newTeacherDoc: TeacherTimetableDoc = {
      id: newId,
      teacherName: 'مامۆستای نوی',
      subject: 'کیمیا',
      lessonCountPerDay: 6,
      schedule: JSON.parse(JSON.stringify(INITIAL_SCHEDULE)),
      notes: 'دروستکراوە لە لایەن ئەدمین',
      updatedAt: new Date().toISOString()
    };
    setAdminEditingTeacher(newTeacherDoc);
    setAdminEditingName(newTeacherDoc.teacherName);
    setAdminEditingSubject(newTeacherDoc.subject);
    setAdminEditingSchedule(JSON.parse(JSON.stringify(INITIAL_SCHEDULE)));
  };

  // Helper for Header Teacher Live Lookup
  const getTeacherTodaySummary = (teacherDoc: TeacherTimetableDoc) => {
    const daySched = teacherDoc.schedule[activeDay];
    if (!daySched || !daySched.slots) {
      return { countToday: 0, lastSlotNum: 0, lastEndTime: "00:00", currentClassNow: "بێ وانە", slots: [] };
    }
    const slots = daySched.slots;
    const activeSlots = slots.filter(s => s.className && s.className !== 'بێ وانە');
    const countToday = activeSlots.length;
    let lastSlotNum = 0;
    let lastEndTime = "00:00";

    slots.forEach((s, i) => {
      if (s.className && s.className !== 'بێ وانە') {
        lastSlotNum = i + 1;
        lastEndTime = s.endTime;
      }
    });

    const activeSlotNow = currentLiveSlot.slot;
    const classNow = activeSlotNow ? activeSlotNow.className : "بێ وانە / فەراغ";

    return {
      countToday,
      lastSlotNum,
      lastEndTime,
      currentClassNow: classNow,
      slots
    };
  };

  const parseClassAndSection = (rawClassStr: string) => {
    if (!rawClassStr || rawClassStr === 'بێ وانە' || rawClassStr === 'فەراغ') {
      return { grade: 'بێ وانە', section: 'فەراغ', fullLabel: 'بێ وانە / فەراغ' };
    }
    const parts = rawClassStr.split('-').map(p => p.trim());
    if (parts.length >= 2) {
      const rawGrade = parts[0];
      const rawSec = parts[1];
      const gradeFormatted = rawGrade.startsWith('پۆلا') ? rawGrade : `پۆلا ${rawGrade}`;
      const sectionFormatted = rawSec.startsWith('هۆبەیا') ? rawSec : `هۆبەیا (${rawSec})`;
      return {
        grade: gradeFormatted,
        section: sectionFormatted,
        fullLabel: `${gradeFormatted} — ${sectionFormatted}`
      };
    }
    return {
      grade: rawClassStr.startsWith('پۆلا') ? rawClassStr : `پۆلا ${rawClassStr}`,
      section: 'هۆبەیا گشتی',
      fullLabel: rawClassStr
    };
  };

  const openTeacherLiveStatusModal = (tDoc: TeacherTimetableDoc) => {
    setSelectedLookupTeacher(tDoc);
    setShowTeacherStatusModal(true);
    setShowHeaderSearchResults(false);
  };



  useEffect(() => {
    updateLiveModeData(effectiveTime);
  }, [effectiveTime, schedule, activeDay, alarmSettings]);

  // Screen WakeLock logic
  const requestWakeLock = async () => {
    if ('wakeLock' in navigator) {
      try {
        if (wakeLock && !wakeLock.released) return;
        const lock = await (navigator as any).wakeLock.request('screen');
        setWakeLock(lock);
        lock.addEventListener('release', () => {
          setWakeLock(null);
        });
      } catch (err) {}
    }
  };

  useEffect(() => {
    requestWakeLock();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') requestWakeLock();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (wakeLock) wakeLock.release();
    };
  }, []);

  useEffect(() => {
    const isStand =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as any).standalone === true;
    setIsStandalone(isStand);
    const ua = window.navigator.userAgent.toLowerCase();
    setIsIOS(/iphone|ipad|ipod/.test(ua));

    const handler = (e: any) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const triggerInstallApp = async () => {
    if (isStandalone) {
      alert("بەرنامە پێشتر وەک ئەپ دابەزێنراوە (Installed) لەسەر ئامێرەکەت!");
      return;
    }
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        setIsStandalone(true);
        setDeferredPrompt(null);
      }
    } else {
      setShowInstallGuideModal(true);
    }
  };

  // LocalStorage Export & Backup Handler
  const exportLocalStorageBackup = () => {
    const backupData = {
      version: "2.0",
      appName: "جەتوەلا من - ماموستا حوسێن",
      exportedAt: new Date().toISOString(),
      schedule,
      alarmSettings,
      customScripts,
      voiceGender,
      activeThemeId: activeTheme.id,
    };
    const jsonStr = JSON.stringify(backupData, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `jadwal_backup_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // LocalStorage Import & Restore Handler
  const importLocalStorageBackup = (file: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target?.result as string);
        if (parsed.schedule) {
          setSchedule(parsed.schedule);
          localStorage.setItem('timetable_data', JSON.stringify(parsed.schedule));
        }
        if (parsed.alarmSettings) {
          setAlarmSettings(parsed.alarmSettings);
          localStorage.setItem('alarm_settings_v9', JSON.stringify(parsed.alarmSettings));
        }
        if (parsed.customScripts) {
          setCustomScripts(parsed.customScripts);
          localStorage.setItem('custom_scripts_v6', JSON.stringify(parsed.customScripts));
        }
        if (parsed.voiceGender) {
          setVoiceGender(parsed.voiceGender);
          localStorage.setItem('voice_gender', parsed.voiceGender);
        }
        if (parsed.activeThemeId) {
          const t = THEMES.find((th) => th.id === parsed.activeThemeId);
          if (t) {
            setActiveTheme(t);
            localStorage.setItem('app_theme_id', t.id);
          }
        }
        setIsSaved(true);
        setTimeout(() => setIsSaved(false), 3000);
        alert("داتای یەدەگ ب سەرکەفتیانە هاتە بارکرن و پاشکەفتن د LocalStorage دا!");
      } catch (err: any) {
        alert("خەلەتی لە فایلی داتادا: " + (err?.message || "فایلی JSON نادروستە"));
      }
    };
    reader.readAsText(file);
  };

  // LocalStorage Reset Handler
  const resetLocalStorageData = () => {
    if (window.confirm("ئەرێ دێ هەمی داتا یێن LocalStorage و خشتەی کەیە وەکی دەستپێکێ؟")) {
      localStorage.removeItem('timetable_data');
      localStorage.removeItem('alarm_settings_v9');
      setSchedule(INITIAL_SCHEDULE);
      setAlarmSettings(DEFAULT_ALARM_SETTINGS);
      localStorage.setItem('timetable_data', JSON.stringify(INITIAL_SCHEDULE));
      localStorage.setItem('alarm_settings_v9', JSON.stringify(DEFAULT_ALARM_SETTINGS));
      alert("بیرگەی وێبگەڕ (LocalStorage) هاتە خاوێنکرن و ڕێسێتکرن بۆ دۆخی سەرەتایی!");
    }
  };

  // Recalculate schedule slots when timing settings change
  const applySettingsToSchedule = (newSettings: AlarmSettings) => {
    setSchedule((prev) => {
      const updated = reconcileScheduleWithDayShifts(prev, newSettings);
      localStorage.setItem('timetable_data', JSON.stringify(updated));
      saveBackupData('timetable_data', updated);
      return updated;
    });
  };

  const updateLiveModeData = (now: Date) => {
    const todayKurdish = getKurdishDayName(now);

    if (!todayKurdish || !schedule[todayKurdish]) {
      setTimeRemaining("شوتیە");
      setCurrentLiveSlot({ slot: null, status: 'none' });
      setNextLiveSlot(null);
      return;
    }

    const todaySlots = schedule[todayKurdish].slots;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const nowSeconds = now.getSeconds();

    let active = null;
    let next = null;
    let status = 'none';
    let targetTimeMinutes = 0;

    for (let i = 0; i < todaySlots.length; i++) {
      const slot = todaySlots[i];
      const [sh, sm] = slot.startTime.split(':').map(Number);
      const [eh, em] = slot.endTime.split(':').map(Number);
      const startTotal = sh * 60 + sm;
      const endTotal = eh * 60 + em;

      if (nowMinutes >= startTotal && nowMinutes < endTotal) {
        active = slot;
        status = 'active';
        targetTimeMinutes = endTotal;
        for (let j = i + 1; j < todaySlots.length; j++) {
          if (todaySlots[j].className !== 'بێ وانە') {
            next = todaySlots[j];
            break;
          }
        }
        break;
      }

      if (i < todaySlots.length - 1) {
        const nextSlot = todaySlots[i + 1];
        const [nsh, nsm] = nextSlot.startTime.split(':').map(Number);
        const nextStartTotal = nsh * 60 + nsm;

        if (nowMinutes >= endTotal && nowMinutes < nextStartTotal) {
          active = null;
          status = 'break';
          targetTimeMinutes = nextStartTotal;
          next = nextSlot;
          break;
        }
      }
    }

    if (!active && status === 'none' && todaySlots.length > 0) {
      const firstSlot = todaySlots[0];
      const [fsh, fsm] = firstSlot.startTime.split(':').map(Number);
      const firstStart = fsh * 60 + fsm;
      if (nowMinutes < firstStart) {
        status = 'upcoming_day';
        targetTimeMinutes = firstStart;
        next = firstSlot;
      }
    }

    setCurrentLiveSlot({ slot: active, status });
    setNextLiveSlot(next);

    if (targetTimeMinutes > 0) {
      if (manualTimeStr) {
        setTimeRemaining("پشکنین");
      } else {
        const totalSecondsLeft = targetTimeMinutes * 60 - (nowMinutes * 60 + nowSeconds);
        if (totalSecondsLeft > 0) {
          const h = Math.floor(totalSecondsLeft / 3600);
          const m = Math.floor((totalSecondsLeft % 3600) / 60);
          const s = totalSecondsLeft % 60;
          setTimeRemaining(`${h > 0 ? h + ':' : ''}${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`);
        } else {
          setTimeRemaining("00:00");
        }
      }
    } else {
      setTimeRemaining("---");
    }
  };

  useEffect(() => {
    if ("Notification" in window && Notification.permission !== "granted") {
      Notification.requestPermission();
    }

    const handleOnline = () => {
      setOnlineToast("📶 پەیوەندیا ئینتەرنێتێ ڤەگەڕیا — هەمی جەتوەل و داتایێن تە پاراستینە ✓");
      setTimeout(() => setOnlineToast(null), 4000);
    };

    const handleOffline = () => {
      setOnlineToast("⚡ مۆدا بێ ئینتەرنێت (ئۆفلاین) — هەمی کار و جەتوەلا تە سەیڤکرییە د ئامێرێ تە دا");
      setTimeout(() => setOnlineToast(null), 4500);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    const initializeAppData = async () => {
      try {
        const saved = localStorage.getItem('timetable_data');
        const savedSettings = localStorage.getItem('alarm_settings_v9');
        const savedView = localStorage.getItem('view_mode');
        const savedGender = localStorage.getItem('voice_gender');
        const savedScripts = localStorage.getItem('custom_scripts_v6');
        const savedThemeId = localStorage.getItem('app_theme_id');
        const savedTeacherName = localStorage.getItem('teacher_name');
        const savedTeacherSubject = localStorage.getItem('teacher_subject');
        const savedApiKey = localStorage.getItem('user_gemini_api_key');

        let currentSchedule: WeekSchedule | null = null;
        if (saved) {
          try { currentSchedule = JSON.parse(saved); } catch (e) {}
        }

        // Fallback to IndexedDB backup if LocalStorage was cleared during browser updates
        if (!currentSchedule) {
          const idbSchedule = await getBackupData('timetable_data');
          if (idbSchedule) {
            currentSchedule = idbSchedule;
            localStorage.setItem('timetable_data', JSON.stringify(idbSchedule));
          }
        }

        if (currentSchedule) {
          const safeSchedule = mergeUserSchedule(currentSchedule, INITIAL_SCHEDULE);
          setSchedule(safeSchedule);
          localStorage.setItem('timetable_data', JSON.stringify(safeSchedule));
          saveBackupData('timetable_data', safeSchedule);
        }

        // Restore teacher info
        let tName = savedTeacherName || await getBackupData('teacher_name');
        let tSubject = savedTeacherSubject || await getBackupData('teacher_subject');
        if (tName) {
          setTeacherName(tName);
          localStorage.setItem('teacher_name', tName);
        }
        if (tSubject) {
          setTeacherSubject(tSubject);
          localStorage.setItem('teacher_subject', tSubject);
        }

        // Restore alarm settings
        if (savedSettings) {
          try {
            const parsed = JSON.parse(savedSettings);
            setAlarmSettings({ ...DEFAULT_ALARM_SETTINGS, ...parsed });
          } catch (e) {}
        } else {
          const idbSettings = await getBackupData('alarm_settings_v9');
          if (idbSettings) {
            setAlarmSettings({ ...DEFAULT_ALARM_SETTINGS, ...idbSettings });
          }
        }

        if (savedView === 'modern' || savedView === 'classic' || savedView === 'live') {
          setViewMode(savedView as any);
        }
        if (savedGender === 'male' || savedGender === 'female') {
          setVoiceGender(savedGender);
        }
        if (savedScripts) {
          try { setCustomScripts(JSON.parse(savedScripts)); } catch (e) {}
        } else {
          const idbScripts = await getBackupData('custom_scripts_v6');
          if (idbScripts) setCustomScripts(idbScripts);
        }
        if (savedThemeId) {
          const theme = THEMES.find((t) => t.id === savedThemeId);
          if (theme) setActiveTheme(theme);
        }
        if (savedApiKey) {
          setUserApiKey(savedApiKey);
        } else {
          const idbKey = await getBackupData('user_gemini_api_key');
          if (idbKey) setUserApiKey(idbKey);
        }
      } catch (err) {
        console.error("Data restore error:", err);
      } finally {
        checkVoicesStatus();
      }
    };

    initializeAppData();
  }, []);

  const checkVoicesStatus = async () => {
    const keys = Object.keys(customScripts);
    const ready = [];
    for (const k of keys) {
      const v = await getVoice(k);
      if (v) ready.push(k);
    }
    setReadyVoices(ready);
  };

  const initAudioContext = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
  };

  const handleInteraction = () => {
    initAudioContext();
    requestWakeLock();
  };

  const stopAllAudio = () => {
    shouldStopRef.current = true;
    if (currentSourceNodeRef.current) {
      try {
        currentSourceNodeRef.current.stop();
        currentSourceNodeRef.current.disconnect();
      } catch (e) {}
      currentSourceNodeRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state === 'running') {
      audioContextRef.current.suspend();
    }
    setActiveAlarm(null);
  };

  const playOfflineVoice = async (id: string, repeats: number = 1) => {
    initAudioContext();
    if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }

    shouldStopRef.current = false;
    const bytes = await getVoice(id);
    if (!bytes || !audioContextRef.current) return false;

    const playOnce = () =>
      new Promise<void>((resolve) => {
        if (!audioContextRef.current || shouldStopRef.current) return resolve();
        const bufferCopy = bytes.buffer.slice(0);
        audioContextRef.current
          .decodeAudioData(bufferCopy)
          .then((decodedBuffer) => {
            if (shouldStopRef.current) return resolve();
            const source = audioContextRef.current!.createBufferSource();
            source.buffer = decodedBuffer;
            source.connect(audioContextRef.current!.destination);
            currentSourceNodeRef.current = source;
            source.onended = () => resolve();
            source.start();
          })
          .catch(() => {
            if (shouldStopRef.current) return resolve();
            const dataInt16 = new Int16Array(bytes.buffer);
            const buffer = audioContextRef.current!.createBuffer(1, dataInt16.length, 24000);
            const channelData = buffer.getChannelData(0);
            for (let i = 0; i < dataInt16.length; i++) channelData[i] = dataInt16[i] / 32768.0;
            const source = audioContextRef.current!.createBufferSource();
            source.buffer = buffer;
            source.connect(audioContextRef.current!.destination);
            currentSourceNodeRef.current = source;
            source.onended = () => resolve();
            source.start();
          });
      });

    for (let i = 0; i < repeats; i++) {
      if (shouldStopRef.current) break;
      await playOnce();
      if (i < repeats - 1) {
        const startWait = Date.now();
        while (Date.now() - startWait < 1000) {
          if (shouldStopRef.current) break;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }
    return true;
  };

  const sendNotification = (title: string, body: string) => {
    if ("Notification" in window && Notification.permission === "granted") {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
          type: 'TRIGGER_ALARM_NOTIFICATION',
          title,
          body,
        });
      } else if (navigator.serviceWorker && navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready.then((reg) => {
          reg.showNotification(title, {
            body: body,
            icon: "./icon-192.png",
            badge: "./icon-192.png",
            vibrate: [300, 100, 300, 100, 300, 100, 500],
            tag: "lesson-alarm-lockscreen",
            renotify: true,
            requireInteraction: true,
          } as any);
        });
      } else {
        new Notification(title, { body, icon: "./icon-192.png" });
      }
    }
  };

  // Lockscreen Wallpaper Render Function (HD 1080x1920)
  const renderWallpaperCanvas = () => {
    const canvas = wallpaperCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = 1080;
    const height = 1920;
    canvas.width = width;
    canvas.height = height;

    // Background Theme
    if (wallpaperTheme === 'amoled') {
      ctx.fillStyle = '#050508';
      ctx.fillRect(0, 0, width, height);
    } else if (wallpaperTheme === 'indigo') {
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(0, '#0f172a');
      grad.addColorStop(0.4, '#1e1b4b');
      grad.addColorStop(1, '#090d16');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);
    } else if (wallpaperTheme === 'emerald') {
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(0, '#022c22');
      grad.addColorStop(0.5, '#064e3b');
      grad.addColorStop(1, '#022c22');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);
    } else if (wallpaperTheme === 'amber') {
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(0, '#451a03');
      grad.addColorStop(0.5, '#78350f');
      grad.addColorStop(1, '#1c1917');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);
    } else {
      const grad = ctx.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(0, '#f8fafc');
      grad.addColorStop(1, '#e2e8f0');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);
    }

    const isLight = wallpaperTheme === 'white';
    const textColor = isLight ? '#0f172a' : '#ffffff';
    const subTextColor = isLight ? '#475569' : '#94a3b8';
    const cardBg = isLight ? 'rgba(255, 255, 255, 0.85)' : 'rgba(255, 255, 255, 0.08)';
    const cardBorder = isLight ? 'rgba(203, 213, 225, 0.8)' : 'rgba(255, 255, 255, 0.15)';
    const accentColor = wallpaperTheme === 'emerald' ? '#34d399' : wallpaperTheme === 'amber' ? '#fbbf24' : '#818cf8';

    // Header Title (optional)
    if (wallpaperShowHeader) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.font = 'bold 30px Vazirmatn, sans-serif';
      ctx.fillStyle = isLight ? '#64748b' : 'rgba(255, 255, 255, 0.4)';
      ctx.fillText('⚡ جهـتوەلا من — شاشەیا قوفلێ', width / 2, 220);

      ctx.font = '900 48px Vazirmatn, sans-serif';
      ctx.fillStyle = textColor;
      ctx.fillText(`${teacherName} — ${teacherSubject}`, width / 2, 280);

      ctx.font = '700 28px Vazirmatn, sans-serif';
      ctx.fillStyle = accentColor;
      ctx.fillText('جەتوەلا وانێن قوتابخانێ (2026)', width / 2, 325);
      ctx.restore();
    }

    // Apply scale & vertical top offset transformation
    ctx.save();
    ctx.translate(width / 2, wallpaperTopY);
    ctx.scale(wallpaperScale, wallpaperScale);
    ctx.translate(-width / 2, -wallpaperTopY);

    let startY = wallpaperTopY;

    if (wallpaperMode === 'today') {
      const todayData = schedule[activeDay] || schedule[DAYS[0]];
      const slots = todayData?.slots || [];

      ctx.save();
      ctx.font = '900 38px Vazirmatn, sans-serif';
      ctx.fillStyle = textColor;
      ctx.textAlign = 'center';
      const dayShift = getDayShift(activeDay, schedule, alarmSettings);
      ctx.fillText(`📅 جەتوەلا ڕۆژا ${activeDay} (${dayShift === 'morning' ? 'سپێدە' : 'نیڤڕۆ'})`, width / 2, startY);
      ctx.restore();

      startY += 55;

      slots.forEach((slot, idx) => {
        const cardX = 80;
        const cardW = width - 160;
        const cardH = 145;

        ctx.save();
        ctx.beginPath();
        if ((ctx as any).roundRect) (ctx as any).roundRect(cardX, startY, cardW, cardH, 28);
        else ctx.rect(cardX, startY, cardW, cardH);
        ctx.fillStyle = cardBg;
        ctx.fill();
        ctx.strokeStyle = cardBorder;
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.fillStyle = accentColor;
        ctx.beginPath();
        if ((ctx as any).roundRect) (ctx as any).roundRect(cardX + 25, startY + 25, 140, 95, 20);
        else ctx.rect(cardX + 25, startY + 25, 140, 95);
        ctx.fill();

        ctx.fillStyle = isLight ? '#ffffff' : '#0f172a';
        ctx.font = '900 34px Vazirmatn, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`وانا ${idx + 1}`, cardX + 95, startY + 82);

        const isEmpty = !slot.className || slot.className === 'بێ وانە';

        if (!isEmpty) {
          ctx.textAlign = 'right';
          ctx.fillStyle = textColor;
          ctx.font = '900 42px Vazirmatn, sans-serif';
          const classNameStr = slot.className.startsWith('پۆلا') ? slot.className : `پۆلا ${slot.className}`;
          ctx.fillText(classNameStr, cardX + cardW - 35, startY + 70);

          ctx.font = '700 28px Vazirmatn, sans-serif';
          ctx.fillStyle = subTextColor;
          ctx.fillText(`${slot.subject || teacherSubject}  •  ⏰ ${slot.startTime} — ${slot.endTime}`, cardX + cardW - 35, startY + 118);
        } else {
          ctx.textAlign = 'right';
          ctx.fillStyle = subTextColor;
          ctx.font = '700 28px Vazirmatn, sans-serif';
          ctx.fillText(`⏰ ${slot.startTime} — ${slot.endTime} (بەتاڵ)`, cardX + cardW - 35, startY + 85);
        }

        ctx.restore();
        startY += cardH + wallpaperSpacing;
      });

    } else {
      // Full Week View - Right To Left (RTL) Layout: Lesson 1 on far right, Lesson 6 on far left
      DAYS.forEach((dayName) => {
        const dayData = schedule[dayName];
        if (!dayData) return;

        const cardX = 50;
        const cardW = width - 100;
        const cardH = 200;

        ctx.save();
        ctx.beginPath();
        if ((ctx as any).roundRect) (ctx as any).roundRect(cardX, startY, cardW, cardH, 24);
        else ctx.rect(cardX, startY, cardW, cardH);
        ctx.fillStyle = cardBg;
        ctx.fill();
        ctx.strokeStyle = cardBorder;
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.textAlign = 'right';
        ctx.font = '900 34px Vazirmatn, sans-serif';
        ctx.fillStyle = accentColor;
        ctx.fillText(`• ${dayName} (${dayData.shift === 'morning' ? 'سپێدە' : 'هێڤاری'})`, cardX + cardW - 25, startY + 48);

        const slotCount = dayData.slots.length || 6;
        const slotWidth = (cardW - 50) / slotCount;

        dayData.slots.forEach((slot, sIdx) => {
          // RTL placement: sIdx = 0 (Lesson 1) gets placed at highest X index (far right)
          const rtlIndex = slotCount - 1 - sIdx;
          const sx = cardX + 25 + rtlIndex * slotWidth;
          const sy = startY + 70;
          const isEmpty = !slot.className || slot.className === 'بێ وانە';

          ctx.beginPath();
          if ((ctx as any).roundRect) (ctx as any).roundRect(sx, sy, slotWidth - 10, 110, 16);
          else ctx.rect(sx, sy, slotWidth - 10, 110);
          ctx.fillStyle = isEmpty
            ? (isLight ? 'rgba(226, 232, 240, 0.3)' : 'rgba(255, 255, 255, 0.02)')
            : (isLight ? 'rgba(79, 70, 229, 0.12)' : 'rgba(99, 102, 241, 0.28)');
          ctx.fill();

          if (!isEmpty) {
            ctx.textAlign = 'center';
            ctx.fillStyle = isLight ? '#475569' : '#cbd5e1';
            ctx.font = 'bold 22px Vazirmatn, sans-serif';
            ctx.fillText(`و${sIdx + 1}`, sx + (slotWidth - 10) / 2, sy + 32);

            ctx.font = '900 28px Vazirmatn, sans-serif';
            ctx.fillStyle = textColor;
            const shortClass = slot.className.replace('پۆلا ', '');
            ctx.fillText(shortClass, sx + (slotWidth - 10) / 2, sy + 72);

            ctx.font = '700 18px Vazirmatn, sans-serif';
            ctx.fillStyle = subTextColor;
            ctx.fillText((slot.subject || teacherSubject).slice(0, 7), sx + (slotWidth - 10) / 2, sy + 98);
          }
          // If empty, leave completely blank without any text!
        });

        ctx.restore();
        startY += cardH + wallpaperSpacing;
      });
    }

    ctx.restore(); // Restore scale translation

    // Optional Footer Badge
    if (wallpaperShowFooter) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.font = '700 28px Vazirmatn, sans-serif';
      ctx.fillStyle = subTextColor;
      ctx.fillText(`📱 بەرنامەیێ جەتوەلا من — ${teacherName} | 2026`, width / 2, height - 60);
      ctx.restore();
    }
  };

  const downloadWallpaperImage = () => {
    const canvas = wallpaperCanvasRef.current;
    if (!canvas) return;
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `jadwal_lockscreen_wallpaper_${wallpaperMode}_${wallpaperTheme}.png`;
    a.click();
  };

  useEffect(() => {
    if (showWallpaperModal) {
      setTimeout(() => {
        renderWallpaperCanvas();
      }, 150);
    }
  }, [
    showWallpaperModal,
    wallpaperTheme,
    wallpaperMode,
    wallpaperTopY,
    wallpaperScale,
    wallpaperSpacing,
    wallpaperShowHeader,
    wallpaperShowFooter,
    teacherName,
    teacherSubject,
    schedule,
    activeDay
  ]);

  // -------------------------------------------------------------------
  // WIDGET STUDIO CANVAS RENDERER & FLOATING PIP LOGIC
  // -------------------------------------------------------------------
  const drawWidgetToCanvas = (
    canvas: HTMLCanvasElement,
    style: 'current' | 'today' | 'bar' | 'week',
    theme: 'amoled' | 'glass' | 'indigo' | 'emerald'
  ) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let width = 800;
    let height = 800;
    if (style === 'today') {
      width = 1200;
      height = 600;
    } else if (style === 'bar') {
      width = 1200;
      height = 320;
    } else if (style === 'week') {
      width = 1200;
      height = 1200;
    }

    canvas.width = width;
    canvas.height = height;

    let bgGrad = ctx.createLinearGradient(0, 0, width, height);
    let cardBg = 'rgba(255, 255, 255, 0.08)';
    let cardBorder = 'rgba(255, 255, 255, 0.18)';
    let primaryTextColor = '#ffffff';
    let subTextColor = '#94a3b8';
    let accentColor = '#6366f1';

    if (theme === 'amoled') {
      bgGrad.addColorStop(0, '#090d16');
      bgGrad.addColorStop(1, '#020617');
      cardBg = 'rgba(30, 41, 59, 0.45)';
      cardBorder = 'rgba(255, 255, 255, 0.14)';
      accentColor = '#38bdf8';
    } else if (theme === 'glass') {
      bgGrad.addColorStop(0, '#0f172a');
      bgGrad.addColorStop(0.5, '#1e1b4b');
      bgGrad.addColorStop(1, '#31103f');
      cardBg = 'rgba(255, 255, 255, 0.1)';
      cardBorder = 'rgba(255, 255, 255, 0.22)';
      accentColor = '#c084fc';
    } else if (theme === 'indigo') {
      bgGrad.addColorStop(0, '#1e1b4b');
      bgGrad.addColorStop(1, '#3730a3');
      cardBg = 'rgba(255, 255, 255, 0.14)';
      cardBorder = 'rgba(255, 255, 255, 0.25)';
      accentColor = '#818cf8';
    } else if (theme === 'emerald') {
      bgGrad.addColorStop(0, '#022c22');
      bgGrad.addColorStop(1, '#064e3b');
      cardBg = 'rgba(255, 255, 255, 0.12)';
      cardBorder = 'rgba(255, 255, 255, 0.22)';
      accentColor = '#34d399';
    }

    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.fillStyle = accentColor;
    ctx.globalAlpha = 0.18;
    ctx.beginPath();
    ctx.arc(width * 0.85, height * 0.15, width * 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const drawRoundedRect = (x: number, y: number, w: number, h: number, r: number, fill: string, stroke?: string, strokeWidth = 2) => {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = strokeWidth;
        ctx.stroke();
      }
      ctx.restore();
    };

    const activeSlot = currentLiveSlot.slot;
    const isBreak = currentLiveSlot.status === 'break';

    if (style === 'current') {
      drawRoundedRect(30, 30, width - 60, height - 60, 48, 'transparent', cardBorder, 3);

      drawRoundedRect(60, 60, width - 120, 64, 32, cardBg, cardBorder, 1.5);
      ctx.textAlign = 'right';
      ctx.font = '900 24px Vazirmatn, sans-serif';
      ctx.fillStyle = primaryTextColor;
      ctx.fillText(`📱 جەتوەلا من — ${teacherName}`, width - 90, 102);

      const nowTimeStr = `${effectiveTime.getHours().toString().padStart(2, '0')}:${effectiveTime.getMinutes().toString().padStart(2, '0')}:${effectiveTime.getSeconds().toString().padStart(2, '0')}`;
      ctx.textAlign = 'left';
      ctx.font = '700 22px Vazirmatn, monospace';
      ctx.fillStyle = accentColor;
      ctx.fillText(nowTimeStr, 90, 101);

      drawRoundedRect(60, 150, width - 120, 400, 40, cardBg, cardBorder, 2);

      const statusText = activeSlot ? "🟢 وانا کارایە" : (isBreak ? "☕ دەمێ فرسەتێ (پشوو)" : "🏁 دەرڤەی دەوامێ");
      const statusBg = activeSlot ? "rgba(16, 185, 129, 0.25)" : (isBreak ? "rgba(245, 158, 11, 0.25)" : "rgba(100, 116, 139, 0.25)");
      const statusBorder = activeSlot ? "#10b981" : (isBreak ? "#f59e0b" : "#64748b");
      drawRoundedRect(width / 2 - 140, 180, 280, 52, 26, statusBg, statusBorder, 2);

      ctx.textAlign = 'center';
      ctx.font = '900 22px Vazirmatn, sans-serif';
      ctx.fillStyle = primaryTextColor;
      ctx.fillText(statusText, width / 2, 214);

      ctx.font = '900 68px Vazirmatn, sans-serif';
      ctx.fillStyle = primaryTextColor;
      ctx.fillText(activeSlot ? activeSlot.className : (isBreak ? 'پشویا کورتا ماموستایی' : 'دەوام ب داوی هات'), width / 2, 315);

      ctx.font = '700 26px Vazirmatn, sans-serif';
      ctx.fillStyle = subTextColor;
      if (activeSlot) {
        ctx.fillText(`بابەت: ${activeSlot.subject || teacherSubject} | کات: ${activeSlot.startTime} — ${activeSlot.endTime}`, width / 2, 370);
      } else {
        ctx.fillText(`${activeDay} — ${teacherSubject}`, width / 2, 370);
      }

      drawRoundedRect(90, 415, width - 180, 105, 28, 'rgba(0, 0, 0, 0.35)', accentColor, 2);
      ctx.font = '700 22px Vazirmatn, sans-serif';
      ctx.fillStyle = subTextColor;
      ctx.fillText("دەمێ مای بۆ زەنگا پاشتر:", width / 2, 450);

      ctx.font = '900 42px Vazirmatn, monospace';
      ctx.fillStyle = accentColor;
      ctx.fillText(timeRemaining || "00:00", width / 2, 498);

      drawRoundedRect(60, 570, width - 120, 160, 36, cardBg, cardBorder, 1.5);
      ctx.textAlign = 'right';
      ctx.font = '900 26px Vazirmatn, sans-serif';
      ctx.fillStyle = primaryTextColor;
      ctx.fillText("وانا پشتڕا (Next Lesson):", width - 100, 620);

      ctx.font = '700 24px Vazirmatn, sans-serif';
      ctx.fillStyle = nextLiveSlot ? accentColor : subTextColor;
      ctx.fillText(
        nextLiveSlot ? `${nextLiveSlot.className} (${nextLiveSlot.startTime} - ${nextLiveSlot.endTime})` : "هیچ وانەیەکی دیکە نییە بۆ ئەمڕۆ",
        width - 100,
        675
      );
    }
    else if (style === 'today') {
      drawRoundedRect(20, 20, width - 40, height - 40, 40, 'transparent', cardBorder, 3);

      drawRoundedRect(40, 40, width - 80, 80, 28, cardBg, cardBorder, 1.5);
      ctx.textAlign = 'right';
      ctx.font = '900 32px Vazirmatn, sans-serif';
      ctx.fillStyle = primaryTextColor;
      ctx.fillText(`📅 جەتوەلا روژا (${activeDay}) — ${teacherName}`, width - 70, 92);

      const nowTimeStr = `${effectiveTime.getHours().toString().padStart(2, '0')}:${effectiveTime.getMinutes().toString().padStart(2, '0')}`;
      ctx.textAlign = 'left';
      ctx.font = '900 30px Vazirmatn, monospace';
      ctx.fillStyle = accentColor;
      ctx.fillText(`🕒 ${nowTimeStr}`, 70, 92);

      const slots = currentDayData?.slots || [];
      const slotsCount = slots.length || 6;
      const paddingX = 40;
      const slotGap = 16;
      const totalWidthForSlots = width - paddingX * 2;
      const slotW = (totalWidthForSlots - slotGap * (slotsCount - 1)) / slotsCount;
      const slotH = 380;
      const slotY = 150;

      slots.forEach((s, idx) => {
        const xPos = width - paddingX - (idx + 1) * slotW - idx * slotGap;
        const isActive = activeSlot?.id === s.id;
        const isEmpty = s.className === 'بێ وانە';

        const sFill = isActive ? 'rgba(99, 102, 241, 0.35)' : (isEmpty ? 'rgba(255, 255, 255, 0.03)' : cardBg);
        const sStroke = isActive ? accentColor : (isEmpty ? 'rgba(255, 255, 255, 0.08)' : cardBorder);

        drawRoundedRect(xPos, slotY, slotW, slotH, 24, sFill, sStroke, isActive ? 3 : 1.5);

        drawRoundedRect(xPos + 12, slotY + 12, slotW - 24, 36, 14, isActive ? accentColor : 'rgba(255, 255, 255, 0.1)', undefined);
        ctx.textAlign = 'center';
        ctx.font = '900 18px Vazirmatn, sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(`و ${idx + 1}`, xPos + slotW / 2, slotY + 37);

        if (!isEmpty) {
          ctx.font = '900 24px Vazirmatn, sans-serif';
          ctx.fillStyle = primaryTextColor;
          const shortClass = s.className.replace('پۆلا ', '');
          ctx.fillText(shortClass, xPos + slotW / 2, slotY + 140);

          ctx.font = '700 16px Vazirmatn, sans-serif';
          ctx.fillStyle = subTextColor;
          ctx.fillText((s.subject || teacherSubject).slice(0, 8), xPos + slotW / 2, slotY + 185);

          drawRoundedRect(xPos + 10, slotY + slotH - 70, slotW - 20, 50, 14, 'rgba(0, 0, 0, 0.3)', undefined);
          ctx.font = '700 14px Vazirmatn, monospace';
          ctx.fillStyle = isActive ? '#a5f3fc' : '#cbd5e1';
          ctx.fillText(`${s.startTime}`, xPos + slotW / 2, slotY + slotH - 46);
          ctx.fillText(`${s.endTime}`, xPos + slotW / 2, slotY + slotH - 26);
        } else {
          ctx.font = '700 16px Vazirmatn, sans-serif';
          ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
          ctx.fillText('بێ وانە', xPos + slotW / 2, slotY + 200);
        }
      });
    }
    else if (style === 'bar') {
      drawRoundedRect(16, 16, width - 32, height - 32, 32, 'transparent', cardBorder, 2.5);
      drawRoundedRect(32, 32, width - 64, height - 64, 24, cardBg, cardBorder, 1.5);

      ctx.textAlign = 'right';
      ctx.font = '900 28px Vazirmatn, sans-serif';
      ctx.fillStyle = primaryTextColor;
      ctx.fillText(`جەتوەلا من — ${teacherName}`, width - 70, 100);

      ctx.font = '700 20px Vazirmatn, sans-serif';
      ctx.fillStyle = subTextColor;
      ctx.fillText(`${activeDay} | ${teacherSubject}`, width - 70, 150);

      drawRoundedRect(width / 2 - 180, 50, 360, 155, 24, activeSlot ? 'rgba(99, 102, 241, 0.3)' : 'rgba(0,0,0,0.2)', accentColor, 2);

      ctx.textAlign = 'center';
      ctx.font = '900 20px Vazirmatn, sans-serif';
      ctx.fillStyle = accentColor;
      ctx.fillText(activeSlot ? "وانا نوکە:" : (isBreak ? "دەمێ فرسەتێ" : "بێ وانە"), width / 2, 85);

      ctx.font = '900 38px Vazirmatn, sans-serif';
      ctx.fillStyle = primaryTextColor;
      ctx.fillText(activeSlot ? activeSlot.className : (isBreak ? 'پشوو' : 'دەوام ب داوی هات'), width / 2, 135);

      ctx.font = '700 18px Vazirmatn, monospace';
      ctx.fillStyle = subTextColor;
      ctx.fillText(`مایە: ${timeRemaining || '00:00'}`, width / 2, 180);

      const nowTimeStr = `${effectiveTime.getHours().toString().padStart(2, '0')}:${effectiveTime.getMinutes().toString().padStart(2, '0')}`;
      ctx.textAlign = 'left';
      ctx.font = '900 36px Vazirmatn, monospace';
      ctx.fillStyle = primaryTextColor;
      ctx.fillText(nowTimeStr, 70, 110);

      ctx.font = '700 18px Vazirmatn, sans-serif';
      ctx.fillStyle = subTextColor;
      ctx.fillText(nextLiveSlot ? `پاشتر: ${nextLiveSlot.className}` : "وانە نەمایە", 70, 160);
    }
    else if (style === 'week') {
      drawRoundedRect(20, 20, width - 40, height - 40, 48, 'transparent', cardBorder, 3);

      drawRoundedRect(40, 40, width - 80, 100, 32, cardBg, cardBorder, 1.5);
      ctx.textAlign = 'right';
      ctx.font = '900 36px Vazirmatn, sans-serif';
      ctx.fillStyle = primaryTextColor;
      ctx.fillText(`خشتەیێ هەفتیانە — ${teacherName} (${teacherSubject})`, width - 80, 102);

      const nowTimeStr = `${effectiveTime.getHours().toString().padStart(2, '0')}:${effectiveTime.getMinutes().toString().padStart(2, '0')}`;
      ctx.textAlign = 'left';
      ctx.font = '900 32px Vazirmatn, monospace';
      ctx.fillStyle = accentColor;
      ctx.fillText(`📱 ${nowTimeStr}`, 80, 102);

      const daysList = DAYS.slice(0, 5);
      const startY = 160;
      const rowH = 180;
      const rowGap = 16;

      daysList.forEach((dayName, dIdx) => {
        const ry = startY + dIdx * (rowH + rowGap);
        const dayData = schedule[dayName];
        const isCurrentDay = activeDay === dayName;

        drawRoundedRect(40, ry, width - 80, rowH, 24, isCurrentDay ? 'rgba(99, 102, 241, 0.2)' : cardBg, isCurrentDay ? accentColor : cardBorder, isCurrentDay ? 2 : 1);

        drawRoundedRect(width - 200, ry + 20, 140, rowH - 40, 18, isCurrentDay ? accentColor : 'rgba(255, 255, 255, 0.1)', undefined);
        ctx.textAlign = 'center';
        ctx.font = '900 22px Vazirmatn, sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(dayName.split(' ')[0], width - 130, ry + rowH / 2 + 8);

        const slots = dayData?.slots || [];
        const slotsCount = 6;
        const totalWForSlots = width - 260 - 60;
        const sW = (totalWForSlots - 10 * (slotsCount - 1)) / slotsCount;

        for (let i = 0; i < slotsCount; i++) {
          const slot = slots[i];
          const sx = width - 230 - (i + 1) * sW - i * 10;
          const isEmpty = !slot || slot.className === 'بێ وانە';

          drawRoundedRect(sx, ry + 20, sW, rowH - 40, 16, isEmpty ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.08)', 'rgba(255,255,255,0.1)', 1);

          ctx.textAlign = 'center';
          ctx.font = '700 16px Vazirmatn, sans-serif';
          ctx.fillStyle = subTextColor;
          ctx.fillText(`و${i + 1}`, sx + sW / 2, ry + 48);

          if (!isEmpty && slot) {
            ctx.font = '900 20px Vazirmatn, sans-serif';
            ctx.fillStyle = primaryTextColor;
            ctx.fillText(slot.className.replace('پۆلا ', ''), sx + sW / 2, ry + 88);

            ctx.font = '700 14px Vazirmatn, monospace';
            ctx.fillStyle = accentColor;
            ctx.fillText(slot.startTime, sx + sW / 2, ry + 124);
          }
        }
      });
    }
  };

  const renderWidgetCanvas = () => {
    if (widgetCanvasRef.current) {
      drawWidgetToCanvas(widgetCanvasRef.current, widgetStyle, widgetTheme);
    }
  };

  const downloadWidgetImage = () => {
    const canvas = widgetCanvasRef.current;
    if (!canvas) return;
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `widget_${widgetStyle}_${widgetTheme}.png`;
    a.click();
  };

  const togglePipWidget = async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setPipActive(false);
        return;
      }

      let pipCanvas = pipCanvasRef.current;
      if (!pipCanvas) {
        pipCanvas = document.createElement('canvas');
        pipCanvas.width = 800;
        pipCanvas.height = 800;
        pipCanvasRef.current = pipCanvas;
      }

      drawWidgetToCanvas(pipCanvas, widgetStyle, widgetTheme);

      const stream = pipCanvas.captureStream(1);
      let video = pipVideoRef.current;
      if (!video) {
        video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        pipVideoRef.current = video;
      }

      video.srcObject = stream;
      await video.play();

      if (document.pictureInPictureEnabled && video.requestPictureInPicture) {
        await video.requestPictureInPicture();
        setPipActive(true);

        video.addEventListener('leavepictureinpicture', () => {
          setPipActive(false);
        });
      } else {
        alert("ئەم وێبگەڕە پشتیوانی لە Picture-in-Picture ناکات. تکایە Chrome لەسەر ئەندرۆید بەکاربهێنە.");
      }
    } catch (err: any) {
      console.error(err);
      alert("خەلەتی ل ڤەکرنا ویجێتێ زێندە: " + (err?.message || "پشتیوانی ناکرێت"));
    }
  };

  useEffect(() => {
    if (showWidgetModal) {
      renderWidgetCanvas();
    }
    if (pipActive && pipCanvasRef.current) {
      drawWidgetToCanvas(pipCanvasRef.current, widgetStyle, widgetTheme);
    }
  }, [
    showWidgetModal,
    widgetStyle,
    widgetTheme,
    effectiveTime,
    teacherName,
    teacherSubject,
    schedule,
    activeDay,
    timeRemaining,
    currentLiveSlot,
    nextLiveSlot,
    pipActive
  ]);

  // Bell scheduling loop
  useEffect(() => {
    if (!alarmSettings.enabled || manualTimeStr) return;
    const interval = setInterval(() => {
      const now = new Date();
      const todayKurdish = getKurdishDayName(now);
      if (!todayKurdish || !schedule[todayKurdish]) return;
      const currentTimeStr =
        now.getHours().toString().padStart(2, '0') + ":" + now.getMinutes().toString().padStart(2, '0');

      schedule[todayKurdish].slots.forEach((slot) => {
        if (slot.className === 'بێ وانە') return;
        const [sh, sm] = slot.startTime.split(':').map(Number);
        const startTime = new Date();
        startTime.setHours(sh, sm, 0, 0);
        const triggerTimeStart = new Date(startTime.getTime() - alarmSettings.minutesBeforeStart * 60000);
        const triggerTimeStartStr =
          triggerTimeStart.getHours().toString().padStart(2, '0') +
          ":" +
          triggerTimeStart.getMinutes().toString().padStart(2, '0');

        if (currentTimeStr === triggerTimeStartStr && now.getSeconds() < 2) {
          const key = `${slot.id}-start-${triggerTimeStartStr}`;
          if (lastTriggeredRef.current !== key) {
            lastTriggeredRef.current = key;
            const isUniversal = alarmSettings.useUniversalSound;
            const msg = isUniversal
              ? (alarmSettings.universalScript || customScripts['universal'] || `ماموستا حسێنێ بەرێز دەرس دەست پێ دکەت - پۆلا ${slot.className}`)
              : (customScripts[slot.className] || `ماموستا حسێنێ بەرێز دەرس دەست پێ دکەت - پۆلا ${slot.className}`);

            setActiveAlarm({ title: `دەستپێکرنا دەرسا ${slot.className}`, msg: msg });

            if (isUniversal) {
              // Try playing universal offline voice first, fallback to class voice
              playOfflineVoice('universal', alarmSettings.repeatCount).then((played) => {
                if (!played) playOfflineVoice(slot.className, alarmSettings.repeatCount);
              });
            } else {
              playOfflineVoice(slot.className, alarmSettings.repeatCount);
            }

            sendNotification(`ئاگاداری - وانێ ${slot.className}`, msg);
          }
        }

        const [eh, em] = slot.endTime.split(':').map(Number);
        const endTime = new Date();
        endTime.setHours(eh, em, 0, 0);
        const triggerTimeEnd = new Date(endTime.getTime() - alarmSettings.minutesBeforeEnd * 60000);
        const triggerTimeEndStr =
          triggerTimeEnd.getHours().toString().padStart(2, '0') +
          ":" +
          triggerTimeEnd.getMinutes().toString().padStart(2, '0');
        if (currentTimeStr === triggerTimeEndStr && now.getSeconds() < 2) {
          const key = `${slot.id}-end-${triggerTimeEndStr}`;
          if (lastTriggeredRef.current !== key) {
            lastTriggeredRef.current = key;
            const msg = customScripts['end'];
            setActiveAlarm({ title: "دەرس بەرەف خلاس بوونێ یە", msg: msg });
            playOfflineVoice('end', alarmSettings.repeatCount);
            sendNotification("ئاگاداری - کۆتاییا وانێ", "دەرس بەرەف خلاس بوونێ یە");
          }
        }
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [alarmSettings, schedule, customScripts, manualTimeStr]);

  const toggleDayShift = (dayName: string) => {
    const currentShift = getDayShift(dayName, schedule, alarmSettings);
    const newShift: ShiftType = currentShift === 'morning' ? 'evening' : 'morning';

    setAlarmSettings((prevSettings) => {
      const updatedDayShifts = { ...(prevSettings.dayShifts || DEFAULT_DAY_SHIFTS), [dayName]: newShift };
      const newSettings = { ...prevSettings, dayShifts: updatedDayShifts };
      try {
        localStorage.setItem('alarm_settings_v10', JSON.stringify(newSettings));
        saveBackupData('alarm_settings_v10', newSettings);
      } catch (e) {}
      return newSettings;
    });

    setSchedule((prev) => {
      const currentDay = prev[dayName] || INITIAL_SCHEDULE[dayName];
      const times = calculateSlotTimes(newShift, alarmSettings);
      const updatedSlots = (currentDay.slots || []).map((s, i) => ({
        ...s,
        startTime: times[i] ? times[i].start : s.startTime,
        endTime: times[i] ? times[i].end : s.endTime,
        isExam: times[i] ? times[i].isExam : false,
      }));
      const updated = {
        ...prev,
        [dayName]: { ...currentDay, shift: newShift, slots: updatedSlots },
      };
      localStorage.setItem('timetable_data', JSON.stringify(updated));
      saveBackupData('timetable_data', updated);

      if (selectedTeacherId) {
        saveTimetableToFirestore(selectedTeacherId, { schedule: updated }).catch(console.warn);
      }

      return updated;
    });
  };

  const getSlotStatus = (startTimeStr: string, endTimeStr: string) => {
    const [sh, sm] = startTimeStr.split(':').map(Number);
    const [eh, em] = endTimeStr.split(':').map(Number);
    const start = new Date(realTime);
    start.setHours(sh, sm, 0, 0);
    const end = new Date(realTime);
    end.setHours(eh, em, 0, 0);

    if (realTime > end) return 'finished';
    if (realTime >= start && realTime <= end) return 'active';

    const diffMins = (start.getTime() - realTime.getTime()) / 60000;
    if (diffMins > 0 && diffMins <= 2) return 'upcoming';

    return 'default';
  };

  const saveToLocal = async () => {
    localStorage.setItem('timetable_data', JSON.stringify(schedule));
    localStorage.setItem('alarm_settings_v9', JSON.stringify(alarmSettings));
    localStorage.setItem('view_mode', viewMode);
    localStorage.setItem('voice_gender', voiceGender);
    localStorage.setItem('custom_scripts_v6', JSON.stringify(customScripts));
    localStorage.setItem('app_theme_id', activeTheme.id);
    localStorage.setItem('teacher_name', teacherName);
    localStorage.setItem('teacher_subject', teacherSubject);
    if (userApiKey) localStorage.setItem('user_gemini_api_key', userApiKey);

    // Dual Backup Store in IndexedDB (Survives app updates & cache wipes)
    await saveBackupData('timetable_data', schedule);
    await saveBackupData('alarm_settings_v9', alarmSettings);
    await saveBackupData('teacher_name', teacherName);
    await saveBackupData('teacher_subject', teacherSubject);
    await saveBackupData('custom_scripts_v6', customScripts);
    await saveBackupData('user_gemini_api_key', userApiKey);

    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 3000);
    handleTeacherSaveAndSubmitChange(schedule);
  };

  const updateSlot = (dayName: string, slotId: string, updates: Partial<LessonSlot>) => {
    setSchedule((prev) => {
      const newDay = { ...prev[dayName] };
      newDay.slots = newDay.slots.map((slot) => (slot.id === slotId ? { ...slot, ...updates } : slot));
      const updated = { ...prev, [dayName]: newDay };
      localStorage.setItem('timetable_data', JSON.stringify(updated));
      saveBackupData('timetable_data', updated);
      return updated;
    });
  };

  const handleSaveApiKey = (key: string) => {
    setUserApiKey(key);
    localStorage.setItem('user_gemini_api_key', key);
    saveBackupData('user_gemini_api_key', key);
  };

  // Secure Server-Side & Client-Side Fallback Voice Generation (Gemini TTS)
  const generateAndStoreVoice = async (id: string, text: string) => {
    setGeneratingId(id);
    try {
      let base64Audio = "";

      // 1. Try server endpoint first (instantly bypassed on static host)
      try {
        const res = await fetchServerWithTimeout("/api/gemini/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, voiceGender, customApiKey: userApiKey }),
        }, 1200);
        if (res.ok && res.headers.get("content-type")?.includes("application/json")) {
          const data = await res.json();
          if (data.success && data.audioBase64) {
            base64Audio = data.audioBase64;
          }
        }
      } catch (sErr) {}

      // 2. Client-side fallback for GitHub Pages / static hosting
      if (!base64Audio) {
        base64Audio = await callClientGeminiTts(userApiKey, text, voiceGender);
      }

      if (!base64Audio) {
        throw new Error("Failed to generate speech");
      }

      const binaryString = atob(base64Audio);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
      await saveVoice(id, bytes);
      setReadyVoices((prev) => Array.from(new Set([...prev, id])));
    } catch (e: any) {
      console.error(e);
      alert("خەلەتیەک هەبوو لە دروستکرنا دەنگی: " + (e?.message || ""));
    } finally {
      setGeneratingId(null);
    }
  };

  const handleFileUpload = async (id: string, file: File) => {
    if (!file) return;
    try {
      const arrayBuffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      await saveVoice(id, uint8Array);
      setReadyVoices((prev) => Array.from(new Set([...prev, id])));
      alert("دەنگ ب سەرکەفتیانە هاتە بارکرن!");
    } catch (e) {
      console.error("Error uploading file:", e);
      alert("خەلەتیەک پەیدابوو.");
    }
  };

  // Extract Timetable with Gemini API (Supports Express backend & GitHub Pages client fallback)
  const handleExtractFromImage = async (useSample: boolean = false, file?: File) => {
    setAiExtracting(true);
    setAiError(null);
    setAiSuccessMessage(null);
    try {
      let base64Data = "";
      let mimeTypeStr = "image/jpeg";
      let extractedDataResult: any = null;

      if (useSample) {
        setAiImagePreview("/assets/aistudio/photo_2026-10-27_21-33-17_62edd79f.jpg");
        extractedDataResult = {
          teacherName: "م حسێن",
          subject: "کیمیا",
          lessonCountPerDay: 6,
          days: [
            { dayName: "ئێکشەمبی", shift: "morning", lessons: ["10 - ب", "10 - د", "بێ وانە", "10 - هـ", "بێ وانە", "10 - و"] },
            { dayName: "دووشەمبی", shift: "morning", lessons: ["10 - ج", "بێ وانە", "10 - و", "بێ وانە", "10 - هـ", "10 - ب"] },
            { dayName: "سێشەمبی", shift: "morning", lessons: ["10 - د", "10 - ج", "بێ وانە", "10 - و", "بێ وانە", "10 - هـ"] },
            { dayName: "چوارشەمبی", shift: "morning", lessons: ["10 - د", "بێ وانە", "10 - ج", "10 - ب", "بێ وانە", "10 - هـ"] },
            { dayName: "پێنچ شەمبی", shift: "morning", lessons: ["10 - ج", "10 - ب", "بێ وانە", "بێ وانە", "10 - و", "10 - د"] }
          ],
          notes: "خشتەیا ماموستا حسێن (کیمیا)"
        };
      } else if (file) {
        base64Data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = (err) => reject(err);
          reader.readAsDataURL(file);
        });
        setAiImagePreview(base64Data);
        mimeTypeStr = file.type || "image/jpeg";
      } else {
        throw new Error("تکایە وێنەیەک دیار بکە");
      }

      if (!useSample) {
        // 1. Try server endpoint first (instantly bypassed on static host)
        try {
          const res = await fetchServerWithTimeout("/api/gemini/extract-schedule", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              imageBase64: base64Data,
              mimeType: mimeTypeStr,
              customApiKey: userApiKey,
              customPrompt: customOcrPrompt,
            }),
          }, 1200);

          if (res.ok && res.headers.get("content-type")?.includes("application/json")) {
            const json = await res.json();
            if (json.success && json.data) {
              extractedDataResult = json.data;
            }
          }
        } catch (sErr) {}

        // 2. Client-side direct fallback for GitHub Pages static host
        if (!extractedDataResult) {
          extractedDataResult = await callClientGeminiExtract(userApiKey, base64Data, mimeTypeStr, customOcrPrompt);
        }
      }

      if (!extractedDataResult) {
        throw new Error("شکست لە دەرهێنانا خشتەی بە هۆی بەردەستنەبوونی API Key");
      }

      setAiPreviewData(extractedDataResult);
      setAiSuccessMessage("🎉 خشتە ب سەرکەفتیانە دەرکەوت و جێبەجێبوو د بەرنامەی دا!");

      // Auto apply teacher name & subject if found
      if (extractedDataResult.teacherName && extractedDataResult.teacherName.trim()) {
        setTeacherName(extractedDataResult.teacherName.trim());
        localStorage.setItem('teacher_name', extractedDataResult.teacherName.trim());
        saveBackupData('teacher_name', extractedDataResult.teacherName.trim());
      }
      if (extractedDataResult.subject && extractedDataResult.subject.trim()) {
        setTeacherSubject(extractedDataResult.subject.trim());
        localStorage.setItem('teacher_subject', extractedDataResult.subject.trim());
        saveBackupData('teacher_subject', extractedDataResult.subject.trim());
      }

      // Automatically apply extracted schedule immediately!
      applyExtractedScheduleData(extractedDataResult);
    } catch (err: any) {
      console.error(err);
      setAiError(err.message || "خەلەتیەک لە پەیوەندی ب جیمینی دروست بوو");
    } finally {
      setAiExtracting(false);
    }
  };

  const updateAiPreviewCell = (dayIndex: number, lessonIndex: number, newValue: string) => {
    if (!aiPreviewData || !aiPreviewData.days) return;
    const updatedDays = [...aiPreviewData.days];
    if (updatedDays[dayIndex]) {
      const lessons = [...(updatedDays[dayIndex].lessons || [])];
      lessons[lessonIndex] = newValue;
      updatedDays[dayIndex] = { ...updatedDays[dayIndex], lessons };
      const newData = { ...aiPreviewData, days: updatedDays };
      setAiPreviewData(newData);
      applyExtractedScheduleData(newData);
    }
  };

  // Apply Extracted Timetable to App Schedule directly
  const applyExtractedScheduleData = (dataToApply?: any) => {
    const data = dataToApply || aiPreviewData;
    if (!data || !data.days) return;

    const firstDayCount = data.days?.[0]?.lessons?.length || 6;
    let count = data.lessonCountPerDay || firstDayCount;
    if (count > 10) count = firstDayCount;
    const newSettings: AlarmSettings = {
      ...alarmSettings,
      lessonCount: count,
    };
    setAlarmSettings(newSettings);

    const updatedSchedule: WeekSchedule = {};

    DAYS.forEach((dayName) => {
      // Find matching day in extracted days
      const extractedDay = data.days.find((d: any) => {
        const norm1 = d.dayName?.replace(/\s+/g, '') || '';
        const norm2 = dayName.replace(/\s+/g, '');
        return norm1.includes(norm2) || norm2.includes(norm1);
      });

      const currentShift = schedule[dayName]?.shift || extractedDay?.shift || 'morning';
      const rawLessons: string[] = extractedDay?.lessons || [];

      // Generate slots using current timing
      const slots = generateSlotsForDay(currentShift, rawLessons, newSettings);

      updatedSchedule[dayName] = {
        dayName: dayName,
        shift: currentShift,
        slots: slots,
      };
    });

    setSchedule(updatedSchedule);
    localStorage.setItem('timetable_data', JSON.stringify(updatedSchedule));
    localStorage.setItem('alarm_settings_v9', JSON.stringify(newSettings));
    saveBackupData('timetable_data', updatedSchedule);
    saveBackupData('alarm_settings_v9', newSettings);

    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 3000);
  };

  const applyExtractedSchedule = () => applyExtractedScheduleData();

  // Parse natural language command for timing with Gemini (Server & Client Fallback)
  const handleAiTimingCommand = async () => {
    if (!aiTimingPrompt.trim()) return;
    setAiTimingLoading(true);
    setAiTimingFeedback(null);
    try {
      let parsedSettings: any = null;

      // 1. Try server endpoint first (instantly bypassed on static host)
      try {
        const res = await fetchServerWithTimeout("/api/gemini/parse-timing-command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: aiTimingPrompt,
            currentSettings: alarmSettings,
            customApiKey: userApiKey,
          }),
        }, 1200);

        if (res.ok && res.headers.get("content-type")?.includes("application/json")) {
          const json = await res.json();
          if (json.success && json.settings) {
            parsedSettings = json.settings;
          }
        }
      } catch (sErr) {}

      // 2. Client-side fallback for GitHub Pages
      if (!parsedSettings) {
        parsedSettings = await callClientGeminiTiming(userApiKey, aiTimingPrompt, alarmSettings);
      }

      if (!parsedSettings) {
        throw new Error("نەهاتە تێگەهشتن");
      }

      const p = parsedSettings;
      const updated: AlarmSettings = {
        ...alarmSettings,
        morningDuration: p.morningDuration ?? alarmSettings.morningDuration,
        eveningDuration: p.eveningDuration ?? alarmSettings.eveningDuration,
        lessonCount: p.lessonCount ?? alarmSettings.lessonCount,
        defaultBreakDuration: p.defaultBreakDuration ?? alarmSettings.defaultBreakDuration,
        longBreakLesson: p.longBreakLesson ?? alarmSettings.longBreakLesson,
        longBreakDuration: p.longBreakDuration ?? alarmSettings.longBreakDuration,
        examSettings: {
          enabled: p.examSettings?.enabled ?? alarmSettings.examSettings.enabled,
          examLessonNumber: p.examSettings?.examLessonNumber ?? alarmSettings.examSettings.examLessonNumber,
          examDuration: p.examSettings?.examDuration ?? alarmSettings.examSettings.examDuration,
          otherLessonsDuration: p.examSettings?.otherLessonsDuration ?? alarmSettings.examSettings.otherLessonsDuration,
          breakAfterExam: p.examSettings?.breakAfterExam ?? alarmSettings.examSettings.breakAfterExam,
        },
      };

      setAlarmSettings(updated);
      applySettingsToSchedule(updated);
      setAiTimingFeedback(p.summaryKurdish || "ڕێکخستن ب سەرکەفتیانە هاتە جێبەجێکرن!");
    } catch (e: any) {
      console.error(e);
      setAiTimingFeedback("خەلەتی: " + (e?.message || ""));
    } finally {
      setAiTimingLoading(false);
    }
  };

  // Quick timing presets
  const applyPreset = (presetType: 'normal' | 'userExam' | 'sevenPeriods' | 'ramadan') => {
    let updated: AlarmSettings;
    if (presetType === 'normal') {
      updated = {
        ...alarmSettings,
        morningDuration: 40,
        eveningDuration: 35,
        lessonCount: 6,
        defaultBreakDuration: 5,
        longBreakLesson: 3,
        longBreakDuration: 10,
        examSettings: { ...alarmSettings.examSettings, enabled: false },
      };
    } else if (presetType === 'userExam') {
      // User's specific scenario:
      // "ئەڤرو دەرسا دوویێ انتیحانە هـەمی قوناغا و وانا دوویێ دێ دەرسا سێیێ دەست پێ کەتن هـەتا دوماهـیک وانە و دەرس بیتە 35خولەک و دەرسا انتیحان بیتە 40خولەک و پشتی دەرسا دوویێ جەرەسێ بکە 10خولەک"
      updated = {
        ...alarmSettings,
        lessonCount: 6,
        defaultBreakDuration: 5,
        examSettings: {
          enabled: true,
          examLessonNumber: 2,
          examDuration: 40,
          otherLessonsDuration: 35,
          breakAfterExam: 10,
        },
      };
    } else if (presetType === 'sevenPeriods') {
      // 7 periods with breaks
      updated = {
        ...alarmSettings,
        lessonCount: 7,
        morningDuration: 40,
        eveningDuration: 35,
        defaultBreakDuration: 5,
        longBreakLesson: 3,
        longBreakDuration: 15,
        examSettings: { ...alarmSettings.examSettings, enabled: false },
      };
    } else {
      // Ramadan / Short shift
      updated = {
        ...alarmSettings,
        morningDuration: 30,
        eveningDuration: 30,
        defaultBreakDuration: 5,
        longBreakLesson: 3,
        longBreakDuration: 10,
        examSettings: { ...alarmSettings.examSettings, enabled: false },
      };
    }

    setAlarmSettings(updated);
    applySettingsToSchedule(updated);
  };

  const updateScript = (key: string, val: string) => setCustomScripts((prev) => ({ ...prev, [key]: val }));

  // Live timeline preview for current active day's times
  const activeDaySlotTimes = calculateSlotTimes(currentDayData?.shift || 'morning', alarmSettings);

  return (
    <div
      className={`min-h-screen bg-slate-50 text-slate-900 pb-24 font-['Vazirmatn'] overflow-x-hidden w-full max-w-full ${
        viewMode === 'classic' ? 'bg-white' : ''
      }`}
      style={{ '--primary-color': activeTheme.color } as React.CSSProperties}
      onClick={handleInteraction}
    >
      {/* Online / Offline Data Protection Notification Toast */}
      {onlineToast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[200] bg-slate-900 text-white font-black text-xs px-5 py-3.5 rounded-2xl shadow-2xl border border-indigo-500/50 flex items-center gap-2.5 animate-in slide-in-from-top duration-300">
          <ShieldCheck className="w-5 h-5 text-emerald-400 animate-pulse" />
          <span>{onlineToast}</span>
        </div>
      )}

      {/* Alarm ringing full-screen modal */}
      {activeAlarm && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-md p-4">
          <div className="bg-white rounded-3xl p-8 max-w-sm w-full shadow-2xl text-center animate-bounce">
            <div className="bg-red-100 text-red-600 w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6">
              <Volume2 className="w-10 h-10 animate-ring" />
            </div>
            <h2 className="text-2xl font-black mb-2 text-slate-800">{activeAlarm.title}</h2>
            <p className="text-slate-600 mb-8 font-medium leading-relaxed">{activeAlarm.msg}</p>
            <button
              onClick={stopAllAudio}
              className="w-full bg-red-600 text-white py-4 rounded-2xl font-bold hover:bg-red-700 shadow-lg transition-all"
            >
              داخستن و ڕاوەستاندن (Close)
            </button>
          </div>
        </div>
      )}

      {/* PWA Install Guide Modal (iOS / Android / Desktop) */}
      {showInstallGuideModal && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 backdrop-blur-md p-4">
          <div className="bg-white rounded-3xl p-6 sm:p-8 max-w-md w-full shadow-2xl space-y-5 animate-in fade-in duration-200">
            <div className="flex items-center justify-between border-b pb-4">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-indigo-600 text-white rounded-2xl shadow-md">
                  <Download className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="font-black text-lg text-slate-800">دابەزاندنا بەرنامەی (Install PWA)</h3>
                  <p className="text-xs text-slate-500">وەک ئەپێک ڕاستەوخۆ دەخرێتە سەر مۆبایلەکەت</p>
                </div>
              </div>
              <button
                onClick={() => setShowInstallGuideModal(false)}
                className="p-1.5 hover:bg-slate-100 rounded-full text-slate-400"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {isIOS ? (
              <div className="space-y-4 text-xs font-medium text-slate-700 bg-indigo-50/70 p-4 rounded-2xl border border-indigo-100">
                <p className="font-black text-indigo-950 text-sm">
                  ڕێنمایی دابەزاندن بۆ ئایفۆن و ئایپاد (iOS Safari):
                </p>
                <ol className="space-y-2.5 list-decimal list-inside pr-1 leading-relaxed">
                  <li>
                    لە خوارەوەی وێبگەڕی Safari کلیک لەسەر دوگمەی <span className="font-bold text-indigo-700">Share (هاوبەشکردن ⎋)</span> بکە.
                  </li>
                  <li>
                    لە لیستەکەدا وەرە خوارەوە و کلیک لە <span className="font-bold text-indigo-700">Add to Home Screen (زیادکردن بۆ سەر شاشە ⊞)</span> بکە.
                  </li>
                  <li>
                    لە بەشی سەرەوەی ڕاست کلیک لە <span className="font-bold text-indigo-700">Add (زیادکردن)</span> بکە.
                  </li>
                </ol>
                <p className="text-[11px] text-indigo-800 mt-2 font-bold">
                  ✨ ئەپەکە بە ئایکۆن دەکەوێتە سەر شاشەی مۆبایلەکەت و ئۆفلاین کاردەکات!
                </p>
              </div>
            ) : (
              <div className="space-y-4 text-xs font-medium text-slate-700 bg-slate-50 p-4 rounded-2xl border border-slate-200">
                <p className="font-black text-slate-900 text-sm">
                  ڕێنمایی دابەزاندن بۆ ئەندرۆید یان کۆمپیوتەر:
                </p>
                <ol className="space-y-2.5 list-decimal list-inside pr-1 leading-relaxed">
                  <li>
                    لە وێبگەڕی Chrome کلیک لەسەر <span className="font-bold text-slate-900">سێ خاڵەکەی سەرەوە (⋮)</span> بکە.
                  </li>
                  <li>
                    هەڵبژاردەی <span className="font-bold text-indigo-600">"Install app (دابەزاندنی بەرنامە)"</span> یان <span className="font-bold text-indigo-600">"Add to Home Screen"</span> دابگرە.
                  </li>
                  <li>
                    کلیک لە <span className="font-bold text-indigo-600">Install</span> بکە.
                  </li>
                </ol>
              </div>
            )}

            <button
              onClick={() => setShowInstallGuideModal(false)}
              className="w-full py-3.5 rounded-2xl bg-indigo-600 hover:bg-indigo-700 text-white font-black text-xs shadow-md transition-all active:scale-95"
            >
              تێگەیشتم (داخستن)
            </button>
          </div>
        </div>
      )}

      {/* Lockscreen Wallpaper Generator Modal */}
      {showWallpaperModal && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/70 backdrop-blur-md p-4 overflow-y-auto">
          <div className="bg-white rounded-[2.5rem] max-w-2xl w-full shadow-2xl overflow-hidden my-auto border border-slate-100 animate-in fade-in duration-200">
            {/* Modal Header */}
            <div className="p-6 border-b flex items-center justify-between bg-gradient-to-r from-cyan-600 via-indigo-600 to-purple-600 text-white">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-white/20 backdrop-blur-sm rounded-2xl shadow-inner">
                  <Smartphone className="w-6 h-6 text-white" />
                </div>
                <div>
                  <h3 className="font-black text-lg text-white">درۆستکەرا ڕەسمێ شاشەیا قوفلێ (Lockscreen Wallpaper)</h3>
                  <p className="text-xs text-cyan-100 font-medium">ڕەسمەکێ بەرزا کیفیەت (HD 1080x1920) دروست بکە بۆ سەر شاشەیا قوفلا مۆبایلا خۆ</p>
                </div>
              </div>
              <button
                onClick={() => setShowWallpaperModal(false)}
                className="p-2 hover:bg-white/20 rounded-full text-white/80 hover:text-white transition-all"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-6 space-y-6 max-h-[80vh] overflow-y-auto no-scrollbar">
              {/* Controls */}
              <div className="space-y-4 bg-slate-50 p-4 rounded-3xl border border-slate-200">
                {/* Teacher Profile Name & Subject Inputs */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pb-3 border-b border-slate-200">
                  <div>
                    <label className="text-xs font-black text-slate-700 block mb-1">ناو و ناڤنیشانێ مامۆستایی:</label>
                    <input
                      type="text"
                      value={teacherName}
                      onChange={(e) => {
                        setTeacherName(e.target.value);
                        localStorage.setItem('teacher_name', e.target.value);
                      }}
                      placeholder="نموونە: ماموستا حوسێن"
                      className="w-full text-xs p-2.5 bg-white border border-slate-200 rounded-xl font-bold outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-black text-slate-700 block mb-1">بابەت / پسپۆڕی:</label>
                    <input
                      type="text"
                      value={teacherSubject}
                      onChange={(e) => {
                        setTeacherSubject(e.target.value);
                        localStorage.setItem('teacher_subject', e.target.value);
                      }}
                      placeholder="نموونە: کیمیا"
                      className="w-full text-xs p-2.5 bg-white border border-slate-200 rounded-xl font-bold outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {/* Mode Selector */}
                  <div>
                    <label className="text-xs font-black text-slate-700 block mb-1.5">ناڤەرۆکا ڕەسمی:</label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => setWallpaperMode('full')}
                        className={`py-2 px-3 rounded-2xl text-xs font-black border transition-all ${
                          wallpaperMode === 'full'
                            ? 'bg-indigo-600 text-white border-indigo-600 shadow-md'
                            : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-100'
                        }`}
                      >
                        خشتەیێ هەمی هەفتێ
                      </button>
                      <button
                        onClick={() => setWallpaperMode('today')}
                        className={`py-2 px-3 rounded-2xl text-xs font-black border transition-all ${
                          wallpaperMode === 'today'
                            ? 'bg-indigo-600 text-white border-indigo-600 shadow-md'
                            : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-100'
                        }`}
                      >
                        جەتوەلا ئەڤڕۆ ({activeDay})
                      </button>
                    </div>
                  </div>

                  {/* Theme Selector */}
                  <div>
                    <label className="text-xs font-black text-slate-700 block mb-1.5">ڕەنگ و ستایلێ بکگراوەندێ:</label>
                    <div className="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar">
                      {[
                        { id: 'indigo', label: 'شین', bg: 'bg-indigo-900', text: 'text-white' },
                        { id: 'amoled', label: 'ڕەش (AMOLED)', bg: 'bg-black', text: 'text-white' },
                        { id: 'emerald', label: 'کەسک', bg: 'bg-emerald-900', text: 'text-white' },
                        { id: 'amber', label: 'پرتەقاڵی', bg: 'bg-amber-900', text: 'text-white' },
                        { id: 'white', label: 'سپی', bg: 'bg-slate-100 border-slate-300', text: 'text-slate-800' },
                      ].map((t) => (
                        <button
                          key={t.id}
                          onClick={() => setWallpaperTheme(t.id as any)}
                          className={`px-2.5 py-1.5 rounded-xl text-[11px] font-bold border transition-all flex items-center gap-1 flex-shrink-0 ${t.bg} ${t.text} ${
                            wallpaperTheme === t.id ? 'ring-2 ring-indigo-500 ring-offset-2 scale-105' : 'opacity-80'
                          }`}
                        >
                          <span>{t.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Fine-Tuning Sliders for Clock Alignment */}
                <div className="pt-3 border-t border-slate-200 grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                  {/* Top Y Offset Slider */}
                  <div className="space-y-1">
                    <div className="flex justify-between font-bold text-slate-600">
                      <span>شوێنی دەستپێک (سەرەوە):</span>
                      <span className="font-black text-indigo-600">{wallpaperTopY}px</span>
                    </div>
                    <input
                      type="range"
                      min="200"
                      max="650"
                      value={wallpaperTopY}
                      onChange={(e) => setWallpaperTopY(parseInt(e.target.value))}
                      className="w-full accent-indigo-600"
                    />
                  </div>

                  {/* Scale Slider */}
                  <div className="space-y-1">
                    <div className="flex justify-between font-bold text-slate-600">
                      <span>قەبارە / حەجم (Scale):</span>
                      <span className="font-black text-indigo-600">{Math.round(wallpaperScale * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min="70"
                      max="130"
                      value={Math.round(wallpaperScale * 100)}
                      onChange={(e) => setWallpaperScale(parseInt(e.target.value) / 100)}
                      className="w-full accent-indigo-600"
                    />
                  </div>

                  {/* Row Spacing Slider */}
                  <div className="space-y-1">
                    <div className="flex justify-between font-bold text-slate-600">
                      <span>دووری ڕێزەکان (Spacing):</span>
                      <span className="font-black text-indigo-600">{wallpaperSpacing}px</span>
                    </div>
                    <input
                      type="range"
                      min="5"
                      max="50"
                      value={wallpaperSpacing}
                      onChange={(e) => setWallpaperSpacing(parseInt(e.target.value))}
                      className="w-full accent-indigo-600"
                    />
                  </div>
                </div>

                {/* Show/Hide Header & Footer Toggles */}
                <div className="pt-2 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs font-bold text-slate-700">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={wallpaperShowHeader}
                      onChange={(e) => setWallpaperShowHeader(e.target.checked)}
                      className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500"
                    />
                    <span>نیشاندانی ناڤ و سەردێڕی سەرەوە</span>
                  </label>

                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={wallpaperShowFooter}
                      onChange={(e) => setWallpaperShowFooter(e.target.checked)}
                      className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500"
                    />
                    <span>نیشاندانی ناڤنیشانی ژێرەوە</span>
                  </label>
                </div>
              </div>

              {/* HD Canvas Preview */}
              <div className="flex flex-col items-center justify-center bg-slate-900 p-4 rounded-3xl border-4 border-slate-800 shadow-inner">
                <p className="text-[11px] text-slate-400 font-bold mb-3 flex items-center gap-1.5">
                  <Smartphone className="w-4 h-4 text-indigo-400" />
                  شاشەیا مۆبایلێ (1080x1920 HD Ratio): ل بەشا سەرەوە جهێ کاتژمێرا قوفلێ چۆڵ هاتیە هێلان
                </p>
                <div className="relative w-full max-w-[280px] aspect-[9/16] rounded-[2rem] overflow-hidden border-4 border-slate-700 shadow-2xl bg-black">
                  <canvas
                    ref={wallpaperCanvasRef}
                    className="w-full h-full object-contain cursor-pointer"
                    title="کلیک بکە بۆ داگرتن"
                    onClick={downloadWallpaperImage}
                  />
                </div>
              </div>

              {/* Instructions */}
              <div className="p-4 rounded-2xl bg-indigo-50/70 border border-indigo-100 text-xs font-bold text-indigo-950 space-y-2">
                <p className="flex items-center gap-1.5 font-black text-indigo-900">
                  <Sparkles className="w-4 h-4 text-indigo-600" />
                  چەوان بکەمە ب باکگراوەندا شاشەیا قوفلا مۆبایلێ (Lock Screen Wallpaper)؟
                </p>
                <ol className="list-decimal list-inside space-y-1 text-slate-700 text-[11px] leading-relaxed">
                  <li>کلیک ل سەر دوگمەیا <span className="text-indigo-700 font-extrabold">"داگرتنا وێنەیێ شاشەیا قوفلێ"</span> بکە دا وێنە بچیتە ناڤ گالەریا مۆبایلێ (Gallery).</li>
                  <li>د ناڤ مۆبایلا خۆ دا بچە سەر **گالەری (Photos)** و ئەو وێنەیە ڤەکە.</li>
                  <li>کلیک ل سەر سێ خاڵان بکە و هەڵبژێرە: **Set as Wallpaper / Lock Screen** (دانان وەک شاشەی قفل).</li>
                </ol>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={downloadWallpaperImage}
                  className="flex-1 py-4 rounded-2xl bg-indigo-600 hover:bg-indigo-700 active:scale-95 text-white font-black text-xs shadow-lg transition-all flex items-center justify-center gap-2"
                >
                  <Download className="w-5 h-5" />
                  <span>داگرتنا وێنەیێ شاشەیا قوفلێ (HD PNG)</span>
                </button>
                <button
                  onClick={() => setShowWallpaperModal(false)}
                  className="py-4 px-6 rounded-2xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs"
                >
                  داخستن
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Home Screen Widget Studio Modal */}
      {showWidgetModal && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/75 backdrop-blur-md p-4 overflow-y-auto">
          <div className="bg-white rounded-[2.5rem] max-w-3xl w-full shadow-2xl overflow-hidden my-auto border border-slate-100 animate-in fade-in duration-200">
            {/* Modal Header */}
            <div className="p-6 border-b flex items-center justify-between bg-gradient-to-r from-amber-500 via-orange-600 to-indigo-600 text-white">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-white/20 backdrop-blur-sm rounded-2xl shadow-inner">
                  <LayoutGrid className="w-6 h-6 text-white" />
                </div>
                <div>
                  <h3 className="font-black text-lg text-white">ستودیۆیا ویجێتێن شاشەی (Home Screen Widgets)</h3>
                  <p className="text-xs text-amber-100 font-medium">4 دیزاینێن ب کەیف بۆ دیارکرنا جەتوەلا وانان و کاتژمێرا مایی ل سەر شاشەیا مۆبایلێ</p>
                </div>
              </div>
              <button
                onClick={() => setShowWidgetModal(false)}
                className="p-2 hover:bg-white/20 rounded-full text-white/80 hover:text-white transition-all"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-6 space-y-6 max-h-[80vh] overflow-y-auto no-scrollbar">
              {/* Controls */}
              <div className="space-y-4 bg-slate-50 p-4 rounded-3xl border border-slate-200">
                {/* Style Selector */}
                <div>
                  <label className="text-xs font-black text-slate-700 block mb-2">هەڵبژارتنا دیزاینا ویجێتی (Widget Design Style):</label>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {[
                      { id: 'current', label: '1. وانا نوکە (2x2 Live)', desc: 'کارتێ ڕاستەوخۆ' },
                      { id: 'today', label: '2. جەتوەلا ئەڤڕۆ (4x2)', desc: 'وانێن ئەمڕۆ' },
                      { id: 'bar', label: '3. شریطێ باریک (4x1)', desc: 'AMOLED Bar' },
                      { id: 'week', label: '4. هەفتیانە (4x4 Grid)', desc: 'خشتەی گشتی' },
                    ].map((st) => (
                      <button
                        key={st.id}
                        onClick={() => {
                          setWidgetStyle(st.id as any);
                          setTimeout(renderWidgetCanvas, 50);
                        }}
                        className={`p-3 rounded-2xl text-right border transition-all flex flex-col justify-between ${
                          widgetStyle === st.id
                            ? 'bg-amber-600 text-white border-amber-600 shadow-md scale-105'
                            : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        <span className="font-black text-xs block">{st.label}</span>
                        <span className={`text-[10px] font-bold mt-1 ${widgetStyle === st.id ? 'text-amber-100' : 'text-slate-400'}`}>
                          {st.desc}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Theme Selector */}
                <div>
                  <label className="text-xs font-black text-slate-700 block mb-1.5">ڕەنگ و تیمی ویجێتی:</label>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {[
                      { id: 'amoled', label: 'AMOLED Black (ڕەش)', bg: 'bg-slate-900 text-cyan-400 border-slate-700' },
                      { id: 'glass', label: 'Glassmorphism (مۆر)', bg: 'bg-purple-950 text-purple-200 border-purple-800' },
                      { id: 'indigo', label: 'Deep Indigo (شین)', bg: 'bg-indigo-900 text-white border-indigo-700' },
                      { id: 'emerald', label: 'Emerald Green (کەسک)', bg: 'bg-emerald-900 text-emerald-200 border-emerald-700' },
                    ].map((t) => (
                      <button
                        key={t.id}
                        onClick={() => {
                          setWidgetTheme(t.id as any);
                          setTimeout(renderWidgetCanvas, 50);
                        }}
                        className={`py-2.5 px-3 rounded-2xl text-xs font-black border transition-all ${t.bg} ${
                          widgetTheme === t.id ? 'ring-2 ring-amber-500 ring-offset-2 scale-105 shadow-md' : 'opacity-80'
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* HD Widget Preview Canvas */}
              <div className="flex flex-col items-center justify-center bg-slate-950 p-4 rounded-3xl border-4 border-slate-800 shadow-inner">
                <p className="text-[11px] text-amber-300 font-bold mb-3 flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-amber-400" />
                  پێشبینینا ڕاستەوخۆ یا ویجێتی (Live High-DPI Widget Preview):
                </p>
                <div className="relative w-full max-w-lg overflow-hidden rounded-3xl border-2 border-slate-700 shadow-2xl bg-black flex items-center justify-center p-2">
                  <canvas
                    ref={widgetCanvasRef}
                    className="w-full h-auto object-contain rounded-2xl cursor-pointer"
                    title="کلیک بکە بۆ داگرتنا وێنەی"
                    onClick={downloadWidgetImage}
                  />
                </div>
              </div>

              {/* Quick Floating PiP Live Widget Feature */}
              <div className="p-4 rounded-3xl bg-gradient-to-r from-amber-500/10 via-indigo-500/10 to-purple-500/10 border-2 border-amber-300/50 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2.5 bg-amber-500 text-white rounded-2xl shadow-md">
                      <MonitorPlay className="w-5 h-5 animate-pulse" />
                    </div>
                    <div>
                      <h4 className="font-black text-sm text-slate-900">ویجێتێ زێندە ل سەر شاشەی (Floating Live PiP Widget)</h4>
                      <p className="text-[11px] text-slate-600 font-medium">پەنجەرەیەکی زێندە لەسەر هەموو بەرنامەکان دەخولێتەوە و خولەک ب خولەک نوێ دەبێتەوە!</p>
                    </div>
                  </div>

                  <button
                    onClick={togglePipWidget}
                    className={`px-4 py-2.5 rounded-2xl text-xs font-black shadow-md flex items-center gap-2 transition-all active:scale-95 ${
                      pipActive
                        ? 'bg-red-600 hover:bg-red-700 text-white animate-pulse'
                        : 'bg-amber-600 hover:bg-amber-700 text-white'
                    }`}
                  >
                    <MonitorPlay className="w-4 h-4" />
                    <span>{pipActive ? 'ڕاوەستاندنا ویجێتێ زێندە' : '⚡ ڤەکرنا ویجێتێ زێندە'}</span>
                  </button>
                </div>
              </div>

              {/* Instructions on how to add to phone home screen */}
              <div className="p-4 rounded-2xl bg-indigo-50/80 border border-indigo-100 text-xs font-bold text-indigo-950 space-y-3">
                <p className="flex items-center gap-1.5 font-black text-indigo-950 text-sm">
                  <Smartphone className="w-5 h-5 text-indigo-600" />
                  چەوان ویجێتی بێخەمە سەر شاشەیا مۆبایلێ (How to add Widget to Home Screen)?
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px] text-slate-700 leading-relaxed font-medium">
                  <div className="p-3 bg-white rounded-xl border border-indigo-100 space-y-1">
                    <span className="font-extrabold text-indigo-900 block text-xs">📱 ڕێکا 1: بەشی Widgets یێ مۆبایلێ (PWA Native):</span>
                    <ol className="list-decimal list-inside space-y-1 pr-1">
                      <li>کاتێک ئەپەکەت دابەزاندووە لەسەر مۆبایلەکەت (Install App).</li>
                      <li>دەست لەسەر شاشەیا سەرەکی مۆبایلەکەت بگرە بۆ 2 چرکە.</li>
                      <li>کلیک لە <b>Widgets (ویجێتەکان)</b> بکە و بگەڕێ بۆ <b>"جەتوەلا من"</b>.</li>
                      <li>ویجێتەکە ڕابکێشە بۆ سەر شاشەی سەرەکی.</li>
                    </ol>
                  </div>

                  <div className="p-3 bg-white rounded-xl border border-indigo-100 space-y-1">
                    <span className="font-extrabold text-indigo-900 block text-xs">🎨 ڕێکا 2: بەکارهێنانا ئەپێن ویجێتی (Widget Launchers):</span>
                    <ol className="list-decimal list-inside space-y-1 pr-1">
                      <li>کلیک ل سەر دوگمەی <b>"داگرتنا وێنەیێ ویجێتی (HD PNG)"</b> بکە.</li>
                      <li>له‌ ئه‌په‌كانی وه‌ك (KWGT, Widgetsmith, WebWidget) ئه‌م وێنه‌یه‌ دیاری بكه‌.</li>
                      <li>ئێستا دەبێتە ویجێتێکی کەشخە ل سەر شاشەیا قوفل یان سەرەکی!</li>
                    </ol>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-3 pt-2">
                <button
                  onClick={downloadWidgetImage}
                  className="flex-1 py-4 rounded-2xl bg-amber-600 hover:bg-amber-700 active:scale-95 text-white font-black text-xs shadow-lg transition-all flex items-center justify-center gap-2"
                >
                  <Download className="w-5 h-5" />
                  <span>داگرتنا وێنەیێ ویجێتی (HD PNG Exporter)</span>
                </button>
                <button
                  onClick={() => setShowWidgetModal(false)}
                  className="py-4 px-6 rounded-2xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs"
                >
                  داخستن
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* AI Timetable Image Scanner Modal */}
      {showAiImportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-md p-4">
          <div className="bg-white rounded-[2.5rem] w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh] border border-slate-100">
            {/* Header */}
            <div className="p-6 border-b flex justify-between items-center bg-gradient-to-r from-indigo-50 to-purple-50">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-indigo-600 text-white rounded-2xl shadow-md">
                  <Sparkles className="w-6 h-6 animate-pulse" />
                </div>
                <div>
                  <h2 className="text-xl font-black text-slate-800">دەرهێنانا جەتوەلێ ب زیرەکییا دەستکرد (Gemini AI)</h2>
                  <p className="text-xs text-slate-500 font-medium">
                    وێنەیێ جەتوەلا وانان باربکە، ئێکسەر دێ هێتە شیکارکرن و تەوزیعکرن
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  setShowAiImportModal(false);
                  setAiError(null);
                }}
                className="p-2 hover:bg-white rounded-full transition-all text-slate-400 hover:text-slate-700"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            {/* Body */}
            <div className="p-6 overflow-y-auto space-y-6 no-scrollbar">
              {/* Gemini API Key Box & Google AI Studio Direct Link */}
              <div className="p-5 rounded-3xl bg-gradient-to-r from-purple-900 via-indigo-900 to-slate-900 text-white space-y-3.5 shadow-lg border border-purple-500/30">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Key className="w-5 h-5 text-yellow-400" />
                    <h3 className="font-black text-sm text-white">تۆمارکرنا API Key یا Google AI Studio</h3>
                  </div>
                  {userApiKey ? (
                    <span className="text-[10px] font-black bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-2.5 py-0.5 rounded-full flex items-center gap-1">
                      <ShieldCheck className="w-3 h-3" /> API Key یا تایبەت چالاکە
                    </span>
                  ) : (
                    <span className="text-[10px] font-black bg-amber-500/20 text-amber-300 border border-amber-500/40 px-2.5 py-0.5 rounded-full">
                      سێرڤەرێ سەرەکی (سیستەم)
                    </span>
                  )}
                </div>

                {/* Google AI Studio Direct Link Button */}
                <a
                  href="https://aistudio.google.com/app/apikey"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between p-3 rounded-2xl bg-white/10 hover:bg-white/20 border border-white/20 transition-all text-xs font-bold text-yellow-300 group"
                >
                  <div className="flex items-center gap-2">
                    <ExternalLink className="w-4 h-4 text-yellow-400 group-hover:scale-110 transition-transform" />
                    <span>کۆپی و وەرگرتنا API Key ژ Google AI Studio (بەبێ بەرامبەر)</span>
                  </div>
                  <span className="text-[10px] bg-yellow-400 text-slate-950 font-black px-2.5 py-1 rounded-xl shadow-xs">
                    کرنا لینکێ AI Studio ↗
                  </span>
                </a>

                {/* API Key Input Box (لاکێشەک) */}
                <div className="space-y-2">
                  <label className="text-[11px] text-purple-200 font-extrabold block">
                    لاکێشا لێدانا API Key (Copy & Paste):
                  </label>
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <input
                        type={showApiKeyText ? "text" : "password"}
                        value={userApiKey}
                        onChange={(e) => {
                          handleSaveApiKey(e.target.value);
                          setKeyValidationStatus(null);
                        }}
                        placeholder="AQ... یان AIzaSy... (API Key یێ خۆ لێرە کۆپی پاست بکە)"
                        className="w-full text-xs p-3 pr-10 bg-black/40 border border-purple-400/40 rounded-2xl text-white font-mono placeholder:text-slate-400 outline-none focus:border-yellow-400 focus:ring-1 focus:ring-yellow-400 transition-all"
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKeyText(!showApiKeyText)}
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white"
                        title={showApiKeyText ? "شاراوە بکە" : "دیار بکە"}
                      >
                        {showApiKeyText ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>

                    {userApiKey ? (
                      <button
                        onClick={() => {
                          handleSaveApiKey('');
                          setKeyValidationStatus(null);
                        }}
                        className="px-3 py-3 rounded-2xl bg-red-500/20 hover:bg-red-500/30 text-red-300 border border-red-500/40 text-xs font-bold transition-all"
                        title="پاقژکرن"
                      >
                        پاقژکرن
                      </button>
                    ) : null}
                  </div>

                  {/* API Key Test & Status Action */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => testApiKey()}
                      disabled={keyValidating}
                      className="flex items-center gap-1.5 px-3.5 py-2 bg-yellow-400 hover:bg-yellow-300 active:scale-95 text-slate-950 rounded-xl font-black text-xs transition-all shadow-md disabled:opacity-50"
                    >
                      {keyValidating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                      <span>پشکنینا API Key (Test Key)</span>
                    </button>

                    {keyValidationStatus === 'valid' && (
                      <span className="text-[11px] font-black text-emerald-300 bg-emerald-900/60 border border-emerald-500/50 px-3 py-1 rounded-xl flex items-center gap-1.5">
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        <span>کلیل کار دکەت ✓ (API Key Active)</span>
                      </span>
                    )}

                    {keyValidationStatus === 'invalid' && (
                      <span className="text-[11px] font-black text-red-300 bg-red-900/60 border border-red-500/50 px-3 py-1 rounded-xl flex items-center gap-1.5">
                        <AlertCircle className="w-3.5 h-3.5 text-red-400" />
                        <span>کلیل خەلەتە ✗ {keyValidationError ? `(${keyValidationError})` : ''}</span>
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Quick test with user's attached photo */}
              <div className="p-5 rounded-3xl bg-indigo-50/70 border-2 border-indigo-100">
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                  <div className="flex items-center gap-3 text-right">
                    <img
                      src="/assets/aistudio/photo_2026-10-27_21-33-17_62edd79f.jpg"
                      alt="Sample"
                      className="w-16 h-16 rounded-2xl object-cover border-2 border-indigo-200 shadow-sm"
                    />
                    <div>
                      <h4 className="font-black text-sm text-indigo-950">وێنەیێ تە هنارتی (جەتوەلا م. حوسێن - کیمیا)</h4>
                      <p className="text-[11px] text-indigo-700 font-medium mt-0.5">
                        ئێکسەر ب ڤی وێنەیێ تە تاقی بکە داکو جەتوەلێ ئۆتۆماتیکی دابمەزرینیت
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => handleExtractFromImage(true)}
                    disabled={aiExtracting}
                    className="flex-shrink-0 flex items-center gap-2 px-5 py-3 rounded-2xl bg-indigo-600 text-white font-bold text-xs hover:bg-indigo-700 active:scale-95 transition-all shadow-md disabled:opacity-50"
                  >
                    {aiExtracting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                    <span>شیکارکرنا ڤی وێنەی</span>
                  </button>
                </div>
              </div>

              {/* Custom Prompt Instruction for Gemini OCR */}
              <div className="p-4 rounded-3xl bg-slate-50 border border-slate-200 space-y-2">
                <label className="text-xs font-black text-slate-700 flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <Wand2 className="w-4 h-4 text-indigo-600" />
                    <span>پەیام و ڕێنمایی تایبەت بۆ جیمینی (Custom Prompt Instruction):</span>
                  </span>
                  <span className="text-[10px] text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full font-bold">
                    بۆ دەرهێنانا دەقیقتر
                  </span>
                </label>
                <input
                  type="text"
                  value={customOcrPrompt}
                  onChange={(e) => setCustomOcrPrompt(e.target.value)}
                  placeholder="ڕێنمایی بۆ جیمینی بنڤێسە..."
                  className="w-full text-xs p-3 bg-white border border-slate-300 rounded-2xl outline-none font-medium text-slate-800 focus:border-indigo-500 transition-all"
                />
                <p className="text-[10px] text-slate-400 font-medium pr-1">
                  💡 ئەڤ تێکستە دگەل وێنەی دچیتە د جیمینی دا دا ناڤێ ماموستای، بابەت و جهـێ پۆلان د وانان دا ب دروستی دیار بکەت.
                </p>
              </div>

              {/* Or upload new custom image */}
              <div className="space-y-3">
                <label className="text-xs font-black text-slate-500 uppercase tracking-widest flex items-center gap-1.5">
                  <Upload className="w-4 h-4" /> بارکرنا وێنەیێ جەتوەلێ (Upload Schedule Photo):
                </label>
                <label className="border-2 border-dashed border-slate-300 hover:border-indigo-400 bg-slate-50 hover:bg-indigo-50/30 rounded-3xl p-8 flex flex-col items-center justify-center cursor-pointer transition-all text-center">
                  <Camera className="w-10 h-10 text-slate-400 mb-2" />
                  <span className="font-bold text-sm text-slate-700">کلیک بکە بۆ هەلبژارتنا وێنەی یان کێشانا رەسمی</span>
                  <span className="text-[11px] text-slate-400 mt-1">PNG, JPG, JPEG یان کامێرە</span>
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files && e.target.files[0]) {
                        handleExtractFromImage(false, e.target.files[0]);
                      }
                    }}
                  />
                </label>
              </div>

              {/* Loading State */}
              {aiExtracting && (
                <div className="p-8 rounded-3xl bg-slate-900 text-white text-center space-y-3 animate-pulse">
                  <Loader2 className="w-8 h-8 animate-spin mx-auto text-indigo-400" />
                  <h3 className="font-black text-lg">جیمینی یێ خشتەی دەردئینیت و تەوزیع دکەت...</h3>
                  <p className="text-xs text-slate-300">
                    ماموستا، بابەت، ڕۆژ و دەرسێن پۆلان دهێنە شیکارکرن
                  </p>
                </div>
              )}

              {/* Success Banner */}
              {aiSuccessMessage && (
                <div className="p-4 rounded-2xl bg-emerald-50 border-2 border-emerald-300 text-emerald-900 text-xs font-black flex items-center justify-between shadow-sm animate-in fade-in">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                    <span>{aiSuccessMessage}</span>
                  </div>
                  <button
                    onClick={() => setShowAiImportModal(false)}
                    className="px-3 py-1 bg-emerald-600 text-white rounded-xl font-bold text-[11px] hover:bg-emerald-700"
                  >
                    داخستن
                  </button>
                </div>
              )}

              {/* Error */}
              {aiError && (
                <div className="p-4 rounded-2xl bg-red-50 border border-red-200 text-red-700 text-xs font-bold flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{aiError}</span>
                </div>
              )}

              {/* Extracted Preview */}
              {aiPreviewData && (
                <div className="space-y-4 animate-in fade-in duration-300">
                  <div className="flex items-center justify-between p-4 bg-emerald-50 rounded-2xl border border-emerald-200 text-emerald-800">
                    <div className="flex items-center gap-2 font-black text-sm">
                      <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                      <span>خشتە ب سەرکەفتیانە دەرهات: {aiPreviewData.teacherName || "ماموستا"} ({aiPreviewData.subject || "کیمیا"})</span>
                    </div>
                    <span className="text-xs bg-emerald-100 text-emerald-700 font-bold px-2.5 py-1 rounded-full">
                      {(aiPreviewData.days?.[0]?.lessons?.length || 6)} دەرسێن ڕۆژانە
                    </span>
                  </div>

                  <div className="flex items-center justify-between text-[11px] font-bold text-slate-500 px-1">
                    <span>✏️ دەتوانی کلیک ل سەر هەر دەرسەکێ بکەی دا بگۆڕی هەگەر جیمینی خەلەتی کربیت:</span>
                    <span className="text-indigo-600 font-extrabold">دەستکاریی دەستبەجێ (Live Edit)</span>
                  </div>

                  <div className="border border-slate-200 rounded-2xl overflow-x-auto bg-white shadow-xs">
                    <table className="w-full text-xs text-center border-collapse">
                      <thead>
                        <tr className="bg-slate-100 text-slate-700 font-black border-b">
                          <th className="p-2.5 border-l">ڕۆژ</th>
                          {Array.from({ length: aiPreviewData.days?.[0]?.lessons?.length || 6 }).map((_, i) => (
                            <th key={i} className="p-2.5 border-l min-w-[90px]">
                              وانا {i + 1}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(aiPreviewData.days || []).map((d: any, idx: number) => (
                          <tr key={idx} className="border-b hover:bg-slate-50">
                            <td className="p-2.5 font-black text-slate-800 bg-slate-50 border-l whitespace-nowrap">{d.dayName}</td>
                            {(d.lessons || []).map((cls: string, ci: number) => {
                              const standardOptions = [
                                "بێ وانە",
                                "10 - أ", "10 - ب", "10 - ج", "10 - د", "10 - هـ", "10 - و",
                                "11 - أ", "11 - ب", "11 - ج", "11 - د", "11 - هـ", "11 - و",
                                "12 - أ", "12 - ب", "12 - ج", "12 - د", "12 - هـ", "12 - و"
                              ];
                              const isCustom = cls && !standardOptions.includes(cls);

                              return (
                                <td key={ci} className="p-1.5 border-l font-bold text-slate-700">
                                  <select
                                    value={cls}
                                    onChange={(e) => updateAiPreviewCell(idx, ci, e.target.value)}
                                    className={`w-full text-center py-1.5 px-1 rounded-xl font-black text-xs outline-none transition-all cursor-pointer border ${
                                      cls === 'بێ وانە'
                                        ? 'bg-slate-100 text-slate-400 border-slate-200'
                                        : 'bg-indigo-50 text-indigo-800 border-indigo-200 focus:ring-2 focus:ring-indigo-500'
                                    }`}
                                  >
                                    <option value="بێ وانە">بێ وانە (بەتاڵ)</option>
                                    <optgroup label="پۆلا 10">
                                      <option value="10 - أ">10 - أ</option>
                                      <option value="10 - ب">10 - ب</option>
                                      <option value="10 - ج">10 - ج</option>
                                      <option value="10 - د">10 - د</option>
                                      <option value="10 - هـ">10 - هـ</option>
                                      <option value="10 - و">10 - و</option>
                                    </optgroup>
                                    <optgroup label="پۆلا 11">
                                      <option value="11 - أ">11 - أ</option>
                                      <option value="11 - ب">11 - ب</option>
                                      <option value="11 - ج">11 - ج</option>
                                      <option value="11 - د">11 - د</option>
                                      <option value="11 - هـ">11 - هـ</option>
                                      <option value="11 - و">11 - و</option>
                                    </optgroup>
                                    <optgroup label="پۆلا 12">
                                      <option value="12 - أ">12 - أ</option>
                                      <option value="12 - ب">12 - ب</option>
                                      <option value="12 - ج">12 - ج</option>
                                      <option value="12 - د">12 - د</option>
                                      <option value="12 - هـ">12 - هـ</option>
                                      <option value="12 - و">12 - و</option>
                                    </optgroup>
                                    {isCustom && <option value={cls}>{cls}</option>}
                                  </select>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <button
                    onClick={applyExtractedSchedule}
                    className="w-full py-4 rounded-2xl text-white font-black text-sm shadow-xl flex items-center justify-center gap-2 active:scale-95 transition-all bg-emerald-600 hover:bg-emerald-700"
                  >
                    <Check className="w-5 h-5" />
                    <span>جێبەجێکرن و دانانا ڤی خشتەی د بەرنامەی دا</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main Settings Modal */}
      {showSettingsModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4">
          <div className="bg-white rounded-[2.5rem] w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[95vh] border border-slate-100">
            {/* Header */}
            <div className="p-6 border-b flex justify-between items-center bg-slate-50">
              <h2
                className="text-xl font-black text-slate-800 flex items-center gap-2"
                style={{ color: 'var(--primary-color)' }}
              >
                <Settings className="w-6 h-6" /> ڕێکخستنێن پێشکەفتی یێن بەرنامەی
              </h2>
              <button
                onClick={() => setShowSettingsModal(false)}
                className="p-2 hover:bg-slate-200/60 rounded-full transition-all"
              >
                <X className="w-6 h-6 text-slate-400" />
              </button>
            </div>

            {/* Navigation Tabs */}
            <div className="flex border-b bg-slate-100/70 p-1.5 gap-1 text-xs font-bold overflow-x-auto no-scrollbar">
              <button
                onClick={() => setSettingsActiveTab('timing')}
                className={`flex items-center gap-1.5 px-4 py-2.5 rounded-xl transition-all whitespace-nowrap ${
                  settingsActiveTab === 'timing'
                    ? 'bg-white shadow text-slate-900 font-black'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                <Clock className="w-4 h-4 text-orange-500" />
                <span>دەمێن دەرسان</span>
              </button>
              <button
                onClick={() => setSettingsActiveTab('exam')}
                className={`flex items-center gap-1.5 px-4 py-2.5 rounded-xl transition-all whitespace-nowrap ${
                  settingsActiveTab === 'exam'
                    ? 'bg-white shadow text-slate-900 font-black'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                <GraduationCap className="w-4 h-4 text-purple-600" />
                <span>مودێ ئیمتیحانێ</span>
                {alarmSettings.examSettings?.enabled && (
                  <span className="w-2 h-2 rounded-full bg-purple-600 animate-ping" />
                )}
              </button>
              <button
                onClick={() => setSettingsActiveTab('ai')}
                className={`flex items-center gap-1.5 px-4 py-2.5 rounded-xl transition-all whitespace-nowrap ${
                  settingsActiveTab === 'ai'
                    ? 'bg-white shadow text-slate-900 font-black'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                <Wand2 className="w-4 h-4 text-indigo-500" />
                <span>یاریدەدەرێ AI</span>
              </button>
              <button
                onClick={() => setSettingsActiveTab('voice')}
                className={`flex items-center gap-1.5 px-4 py-2.5 rounded-xl transition-all whitespace-nowrap ${
                  settingsActiveTab === 'voice'
                    ? 'bg-white shadow text-slate-900 font-black'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                <Bell className="w-4 h-4 text-emerald-600" />
                <span>زەنگ و دەنگ</span>
              </button>
              <button
                onClick={() => setSettingsActiveTab('storage')}
                className={`flex items-center gap-1.5 px-4 py-2.5 rounded-xl transition-all whitespace-nowrap ${
                  settingsActiveTab === 'storage'
                    ? 'bg-white shadow text-slate-900 font-black'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                <HardDrive className="w-4 h-4 text-cyan-600" />
                <span>LocalStorage و PWA</span>
              </button>
              <button
                onClick={() => setSettingsActiveTab('general')}
                className={`flex items-center gap-1.5 px-4 py-2.5 rounded-xl transition-all whitespace-nowrap ${
                  settingsActiveTab === 'general'
                    ? 'bg-white shadow text-slate-900 font-black'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                <Palette className="w-4 h-4 text-blue-500" />
                <span>گشتی</span>
              </button>
            </div>

            {/* Tab Contents */}
            <div className="p-6 overflow-y-auto space-y-6 no-scrollbar">
              {/* TAB 1: TIMINGS & BREAKS */}
              {settingsActiveTab === 'timing' && (
                <div className="space-y-6">
                  {/* Preset quick buttons */}
                  <div className="space-y-2">
                    <label className="text-xs font-black text-slate-400 uppercase tracking-widest">
                      هەڵبژارتنا بلەز (Presets):
                    </label>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <button
                        onClick={() => applyPreset('normal')}
                        className="p-3 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-2xl text-right font-bold transition-all text-slate-700"
                      >
                        ☀️ دەواما ئاسایی (سپێدە 40، هێڤاری 35)
                      </button>
                      <button
                        onClick={() => applyPreset('sevenPeriods')}
                        className="p-3 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-2xl text-right font-bold transition-all text-slate-700"
                      >
                        🔔 7 دەرس (دگەل 15 خولەک فرسەت)
                      </button>
                      <button
                        onClick={() => applyPreset('ramadan')}
                        className="p-3 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-2xl text-right font-bold transition-all text-slate-700"
                      >
                        🌙 کورتکری / ڕەمەزان (30 خولەک)
                      </button>
                      <button
                        onClick={() => applyPreset('userExam')}
                        className="p-3 bg-purple-50 hover:bg-purple-100 border border-purple-200 rounded-2xl text-right font-bold transition-all text-purple-900"
                      >
                        📝 ئیمتیحان: دەرسا دوویێ (40 خولەک)
                      </button>
                    </div>
                  </div>

                  {/* Morning shift duration */}
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <label className="text-xs font-black text-slate-700 flex items-center gap-1.5">
                        <Sun className="w-4 h-4 text-orange-500" /> دەمێ هەر دەرسەکا سپێدێ:
                      </label>
                      <span className="text-xs font-black text-orange-600 bg-orange-50 px-2 py-0.5 rounded-lg">
                        {alarmSettings.morningDuration} خولەک
                      </span>
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      {[30, 35, 40, 45].map((mins) => (
                        <button
                          key={mins}
                          onClick={() => {
                            const updated = { ...alarmSettings, morningDuration: mins };
                            setAlarmSettings(updated);
                            applySettingsToSchedule(updated);
                          }}
                          className={`py-2.5 rounded-xl font-black text-xs transition-all border ${
                            alarmSettings.morningDuration === mins
                              ? 'bg-orange-500 text-white border-orange-500 shadow-md'
                              : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                          }`}
                        >
                          {mins} خولەک
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Evening shift duration */}
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <label className="text-xs font-black text-slate-700 flex items-center gap-1.5">
                        <Moon className="w-4 h-4 text-indigo-500" /> دەمێ هەر دەرسەکا هێڤاری:
                      </label>
                      <span className="text-xs font-black text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-lg">
                        {alarmSettings.eveningDuration} خولەک
                      </span>
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      {[30, 35, 40, 45].map((mins) => (
                        <button
                          key={mins}
                          onClick={() => {
                            const updated = { ...alarmSettings, eveningDuration: mins };
                            setAlarmSettings(updated);
                            applySettingsToSchedule(updated);
                          }}
                          className={`py-2.5 rounded-xl font-black text-xs transition-all border ${
                            alarmSettings.eveningDuration === mins
                              ? 'bg-indigo-600 text-white border-indigo-600 shadow-md'
                              : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                          }`}
                        >
                          {mins} خولەک
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Number of Lessons per day */}
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <label className="text-xs font-black text-slate-700 flex items-center gap-1.5">
                        <LayoutGrid className="w-4 h-4 text-slate-600" /> ژمارا دەرسێن ڕۆژانە (وانە):
                      </label>
                      <span className="text-xs font-black text-slate-800 bg-slate-100 px-2 py-0.5 rounded-lg">
                        {alarmSettings.lessonCount || 6} دەرس
                      </span>
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      {[5, 6, 7, 8].map((count) => (
                        <button
                          key={count}
                          onClick={() => {
                            const updated = { ...alarmSettings, lessonCount: count };
                            setAlarmSettings(updated);
                            applySettingsToSchedule(updated);
                          }}
                          className={`py-2.5 rounded-xl font-black text-xs transition-all border ${
                            (alarmSettings.lessonCount || 6) === count
                              ? 'bg-slate-900 text-white border-slate-900 shadow-md'
                              : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100'
                          }`}
                        >
                          {count} دەرس
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Breaks Configuration */}
                  <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-4">
                    <h3 className="text-xs font-black text-slate-700 flex items-center gap-1.5">
                      <Coffee className="w-4 h-4 text-amber-600" /> فرسەت و جەرەسێن بەینێ:
                    </h3>

                    <div className="space-y-1">
                      <div className="flex justify-between text-xs font-bold text-slate-600">
                        <span>جەرەسێ ئاساییێ بەینا هەمی دەرسان:</span>
                        <span className="text-slate-800 font-black">{alarmSettings.defaultBreakDuration || 5} خولەک</span>
                      </div>
                      <input
                        type="range"
                        min="2"
                        max="15"
                        value={alarmSettings.defaultBreakDuration || 5}
                        onChange={(e) => {
                          const updated = { ...alarmSettings, defaultBreakDuration: parseInt(e.target.value) };
                          setAlarmSettings(updated);
                          applySettingsToSchedule(updated);
                        }}
                        className="w-full accent-amber-600"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-200">
                      <div>
                        <label className="text-[11px] font-bold text-slate-500 block mb-1">
                          فرسەتا مەزن پشتی دەرسا:
                        </label>
                        <select
                          value={alarmSettings.longBreakLesson || 3}
                          onChange={(e) => {
                            const updated = { ...alarmSettings, longBreakLesson: parseInt(e.target.value) };
                            setAlarmSettings(updated);
                            applySettingsToSchedule(updated);
                          }}
                          className="w-full text-xs p-2 bg-white border border-slate-200 rounded-xl outline-none font-bold"
                        >
                          {[1, 2, 3, 4, 5].map((n) => (
                            <option key={n} value={n}>
                              وانا {n}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="text-[11px] font-bold text-slate-500 block mb-1">
                          دەمێ فرسەتا مەزن:
                        </label>
                        <select
                          value={alarmSettings.longBreakDuration || 10}
                          onChange={(e) => {
                            const updated = { ...alarmSettings, longBreakDuration: parseInt(e.target.value) };
                            setAlarmSettings(updated);
                            applySettingsToSchedule(updated);
                          }}
                          className="w-full text-xs p-2 bg-white border border-slate-200 rounded-xl outline-none font-bold"
                        >
                          <option value={10}>10 خولەک</option>
                          <option value={15}>15 خولەک</option>
                          <option value={20}>20 خولەک</option>
                          <option value={25}>25 خولەک</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 2: EXAM MODE (USER REQUIREMENT) */}
              {settingsActiveTab === 'exam' && (
                <div className="space-y-6">
                  <div className="p-4 bg-purple-50 rounded-3xl border border-purple-200 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="p-2 bg-purple-600 text-white rounded-xl">
                          <GraduationCap className="w-5 h-5" />
                        </div>
                        <div>
                          <h4 className="font-black text-sm text-purple-950">مودێ ئیمتیحانێ یێ ئەڤڕۆ</h4>
                          <p className="text-[11px] text-purple-700">دەرسەکا تاقیکردنەوە دگەل گونجاندنا دەمێن دەرسێن دی</p>
                        </div>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={alarmSettings.examSettings?.enabled || false}
                          onChange={(e) => {
                            const updated: AlarmSettings = {
                              ...alarmSettings,
                              examSettings: {
                                ...alarmSettings.examSettings,
                                enabled: e.target.checked,
                              },
                            };
                            setAlarmSettings(updated);
                            applySettingsToSchedule(updated);
                          }}
                          className="sr-only peer"
                        />
                        <div className="w-12 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:right-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600"></div>
                      </label>
                    </div>

                    {alarmSettings.examSettings?.enabled && (
                      <div className="pt-3 border-t border-purple-200 space-y-4">
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="text-[11px] font-black text-purple-900 block mb-1">
                              کیش دەرس ئیمتیحانە؟
                            </label>
                            <select
                              value={alarmSettings.examSettings.examLessonNumber}
                              onChange={(e) => {
                                const updated: AlarmSettings = {
                                  ...alarmSettings,
                                  examSettings: {
                                    ...alarmSettings.examSettings,
                                    examLessonNumber: parseInt(e.target.value),
                                  },
                                };
                                setAlarmSettings(updated);
                                applySettingsToSchedule(updated);
                              }}
                              className="w-full text-xs p-2.5 bg-white border border-purple-300 rounded-xl font-black text-purple-900 outline-none"
                            >
                              {Array.from({ length: alarmSettings.lessonCount || 6 }).map((_, i) => (
                                <option key={i + 1} value={i + 1}>
                                  دەرسا {i + 1} ({i + 1 === 2 ? 'یا دوویێ - انتیحان' : `وانا ${i + 1}`})
                                </option>
                              ))}
                            </select>
                          </div>

                          <div>
                            <label className="text-[11px] font-black text-purple-900 block mb-1">
                              دەمێ دەرسا ئیمتیحانێ:
                            </label>
                            <select
                              value={alarmSettings.examSettings.examDuration}
                              onChange={(e) => {
                                const updated: AlarmSettings = {
                                  ...alarmSettings,
                                  examSettings: {
                                    ...alarmSettings.examSettings,
                                    examDuration: parseInt(e.target.value),
                                  },
                                };
                                setAlarmSettings(updated);
                                applySettingsToSchedule(updated);
                              }}
                              className="w-full text-xs p-2.5 bg-white border border-purple-300 rounded-xl font-black text-purple-900 outline-none"
                            >
                              <option value={35}>35 خولەک</option>
                              <option value={40}>40 خولەک</option>
                              <option value={45}>45 خولەک</option>
                              <option value={50}>50 خولەک</option>
                              <option value={60}>60 خولەک (١ سەعەت)</option>
                            </select>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <label className="text-[11px] font-black text-purple-900 block mb-1">
                              دەمێ دەرسێن دی یێن ئاسایی:
                            </label>
                            <select
                              value={alarmSettings.examSettings.otherLessonsDuration}
                              onChange={(e) => {
                                const updated: AlarmSettings = {
                                  ...alarmSettings,
                                  examSettings: {
                                    ...alarmSettings.examSettings,
                                    otherLessonsDuration: parseInt(e.target.value),
                                  },
                                };
                                setAlarmSettings(updated);
                                applySettingsToSchedule(updated);
                              }}
                              className="w-full text-xs p-2.5 bg-white border border-purple-300 rounded-xl font-black text-purple-900 outline-none"
                            >
                              <option value={30}>30 خولەک</option>
                              <option value={35}>35 خولەک</option>
                              <option value={40}>40 خولەک</option>
                            </select>
                          </div>

                          <div>
                            <label className="text-[11px] font-black text-purple-900 block mb-1">
                              فرسەت پشتی ئیمتیحانێ:
                            </label>
                            <select
                              value={alarmSettings.examSettings.breakAfterExam}
                              onChange={(e) => {
                                const updated: AlarmSettings = {
                                  ...alarmSettings,
                                  examSettings: {
                                    ...alarmSettings.examSettings,
                                    breakAfterExam: parseInt(e.target.value),
                                  },
                                };
                                setAlarmSettings(updated);
                                applySettingsToSchedule(updated);
                              }}
                              className="w-full text-xs p-2.5 bg-white border border-purple-300 rounded-xl font-black text-purple-900 outline-none"
                            >
                              <option value={5}>5 خولەک</option>
                              <option value={10}>10 خولەک (جەرەسێ 10 خولەک)</option>
                              <option value={15}>15 خولەک</option>
                            </select>
                          </div>
                        </div>

                        {/* Exact scenario explanation */}
                        <div className="p-3 bg-white/80 rounded-2xl border border-purple-200 text-xs text-purple-900 font-medium leading-relaxed">
                          📌 <strong>شیکارکرن:</strong> دەرسا {alarmSettings.examSettings.examLessonNumber} ئیمتیحانە (
                          {alarmSettings.examSettings.examDuration} خولەک)، پاشان فرسەت {alarmSettings.examSettings.breakAfterExam} خولەکە،
                          و دەرسا {alarmSettings.examSettings.examLessonNumber + 1} ئێکسەر دەست پێ دکەت هەتا دوماهیکێ بە دەوامی {alarmSettings.examSettings.otherLessonsDuration} خولەک.
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Calculated live schedule preview */}
                  <div className="space-y-2">
                    <label className="text-xs font-black text-slate-500 uppercase tracking-widest">
                      خشتەیێ کاتێن ئەڤڕۆ ب پێی ڤێ ڕێکخستنێ:
                    </label>
                    <div className="space-y-1.5 bg-slate-50 p-3 rounded-2xl border border-slate-200">
                      {activeDaySlotTimes.map((t, idx) => (
                        <div
                          key={idx}
                          className={`flex items-center justify-between p-2.5 rounded-xl text-xs font-bold ${
                            t.isExam
                              ? 'bg-purple-600 text-white shadow-sm'
                              : 'bg-white border border-slate-200 text-slate-700'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span>وانا {idx + 1}</span>
                            {t.isExam && (
                              <span className="bg-purple-800 text-purple-200 text-[10px] px-2 py-0.5 rounded-full font-black">
                                تاقیکردنەوە / انتیحان 📝
                              </span>
                            )}
                          </div>
                          <span className="font-mono tabular-nums">
                            {t.start} — {t.end}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 3: AI NATURAL LANGUAGE TIMING ASSISTANT */}
              {settingsActiveTab === 'ai' && (
                <div className="space-y-4">
                  <div className="p-4 bg-gradient-to-r from-indigo-50 to-purple-50 rounded-3xl border border-indigo-100 space-y-2">
                    <div className="flex items-center gap-2 font-black text-sm text-indigo-950">
                      <Wand2 className="w-5 h-5 text-indigo-600" />
                      <span>ڕێکخستنا زیرەک ب زمانێ کوردی (Gemini AI)</span>
                    </div>
                    <p className="text-xs text-indigo-700 leading-relaxed font-medium">
                      ب هەر شێوازەکێ بتەڤێت بنڤیسە: بۆ نموونە "ئەڤرو دەرسا دوویێ ئیمتیحانە 40 خولەک و یێن دی 35 خولەک و پشتی دەرسا دوویێ جەرەسێ بکە 10 خولەک" یان "سپێدا 40 و هێڤاری 35 و بکە 7 دەرس"...
                    </p>
                  </div>

                  <div className="space-y-2">
                    <textarea
                      value={aiTimingPrompt}
                      onChange={(e) => setAiTimingPrompt(e.target.value)}
                      placeholder="لڤێرە بنڤیسە: بۆ نموونە: ئەڤرو دەرسا دوویێ انتیحانە هەمی قوناغا و دەرس بیتە 35 خولەک و دەرسا انتیحان 40 خولەک..."
                      className="w-full text-xs p-4 bg-slate-50 border-2 border-slate-200 rounded-2xl outline-none focus:border-indigo-500 min-h-[90px] leading-relaxed font-medium"
                    />

                    {/* Quick suggestion tags */}
                    <div className="flex flex-wrap gap-1.5">
                      {[
                        "ئەڤرو دەرسا دوویێ انتیحانە 40 خولەک و یێن دی 35 خولەک و جەرەس 10 خولەک",
                        "هەر دەرسەک سپێدا 40 خولەکە و هێڤاری 35 خولەکە",
                        "بکە حەفت دەرس و فرسەتا مەزن 15 خولەک",
                        "ڕەمەزانە هەمی دەرسان بکە 30 خولەک",
                      ].map((promptText, i) => (
                        <button
                          key={i}
                          onClick={() => setAiTimingPrompt(promptText)}
                          className="text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-600 px-3 py-1.5 rounded-full font-bold transition-all text-right"
                        >
                          + {promptText}
                        </button>
                      ))}
                    </div>

                    <button
                      onClick={handleAiTimingCommand}
                      disabled={aiTimingLoading || !aiTimingPrompt.trim()}
                      className="w-full py-3.5 rounded-2xl text-white font-black text-xs shadow-lg flex items-center justify-center gap-2 bg-indigo-600 hover:bg-indigo-700 active:scale-95 transition-all disabled:opacity-50"
                    >
                      {aiTimingLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                      <span>شیکارکرن و جێبەجێکرن ب Gemini AI</span>
                    </button>
                  </div>

                  {aiTimingFeedback && (
                    <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-bold flex items-center gap-2 animate-in fade-in">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                      <span>{aiTimingFeedback}</span>
                    </div>
                  )}
                </div>
              )}

              {/* TAB 4: BELL & VOICES */}
              {settingsActiveTab === 'voice' && (
                <div className="space-y-6">
                  {/* Master Universal Bell Sound Toggle Card */}
                  <div className="p-4 bg-gradient-to-r from-emerald-50 to-teal-50 rounded-3xl border-2 border-emerald-200 shadow-sm space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="p-3 bg-emerald-600 text-white rounded-2xl shadow-md">
                          <Bell className="w-6 h-6 animate-ring" />
                        </div>
                        <div>
                          <h4 className="font-black text-sm text-emerald-950">دەنگێ گشتی / جەرەسێ قوتابخانێ بۆ هەمی وانان</h4>
                          <p className="text-[11px] text-emerald-700 font-medium">ئێک دەنگ و زەنگ بۆ هەمی پۆل و بابەتان پێکڤە (یەکپارچە)</p>
                        </div>
                      </div>

                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={alarmSettings.useUniversalSound || false}
                          onChange={(e) => {
                            const updated = { ...alarmSettings, useUniversalSound: e.target.checked };
                            setAlarmSettings(updated);
                            localStorage.setItem('alarm_settings_v9', JSON.stringify(updated));
                          }}
                          className="sr-only peer"
                        />
                        <div className="w-12 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:right-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-600"></div>
                      </label>
                    </div>

                    {/* Universal Sound Script & Action Buttons */}
                    <div className="pt-3 border-t border-emerald-200/80 space-y-3">
                      <label className="text-[11px] font-black text-emerald-900 block">دەقێ ئاگەهداریا گشتی (Universal Voice Script):</label>
                      <textarea
                        value={alarmSettings.universalScript || customScripts['universal'] || "ماموستا حسێنێ بەرێز دەرس دەست پێ دکەت - هیڤیدارم بچنە پۆلێ دگەل رێزو سلاڤان"}
                        onChange={(e) => {
                          const newScript = e.target.value;
                          setAlarmSettings((p) => ({ ...p, universalScript: newScript }));
                          updateScript('universal', newScript);
                        }}
                        placeholder="دەقێ دەنگی بنڤیسە..."
                        className="w-full text-xs p-3 bg-white border border-emerald-200 rounded-2xl outline-none font-medium leading-relaxed text-slate-800"
                        rows={2}
                      />

                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          onClick={() => generateAndStoreVoice('universal', alarmSettings.universalScript || customScripts['universal'] || "ماموستا حسێنێ بەرێز دەرس دەست پێ دکەت")}
                          disabled={generatingId !== null}
                          className="flex-1 py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs shadow-md flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-50"
                        >
                          {generatingId === 'universal' ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Sparkles className="w-4 h-4 text-yellow-300" />
                          )}
                          <span>دروستکرنا دەنگێ گشتی (Gemini AI)</span>
                        </button>

                        {readyVoices.includes('universal') && (
                          <button
                            onClick={() => playOfflineVoice('universal', 1)}
                            className="p-2.5 bg-white text-emerald-700 hover:bg-emerald-100 rounded-xl border border-emerald-300 font-bold text-xs shadow-xs flex items-center gap-1.5 active:scale-95 transition-all"
                            title="تاقیکرنا دەنگی"
                          >
                            <Play className="w-4 h-4 text-emerald-600" />
                            <span>تاقیکرن</span>
                          </button>
                        )}

                        <label className="p-2.5 bg-white hover:bg-emerald-100 text-emerald-700 rounded-xl border border-emerald-300 font-bold text-xs cursor-pointer shadow-xs flex items-center gap-1.5 transition-all">
                          <Upload className="w-4 h-4 text-emerald-600" />
                          <span>بارکرنا فایلی MP3</span>
                          <input
                            type="file"
                            accept="audio/*"
                            className="hidden"
                            onChange={(e) => e.target.files && handleFileUpload('universal', e.target.files[0])}
                          />
                        </label>
                      </div>
                    </div>
                  </div>
                  {/* Alarm Offset Sliders */}
                  <div className="space-y-4 p-4 bg-slate-50 rounded-2xl border border-slate-200">
                    <h3 className="text-xs font-black text-slate-700 flex items-center gap-1.5">
                      <Bell className="w-4 h-4 text-orange-600" /> دەمێ ئاگەهداریا زەنگێ (خولەک بەری وەختی):
                    </h3>
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs font-bold text-slate-500">
                        <span>بەری دەرس دەستپێبکەت:</span>
                        <span className="font-black" style={{ color: 'var(--primary-color)' }}>
                          {alarmSettings.minutesBeforeStart} خولەک
                        </span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="10"
                        value={alarmSettings.minutesBeforeStart}
                        onChange={(e) =>
                          setAlarmSettings((p) => ({ ...p, minutesBeforeStart: parseInt(e.target.value) }))
                        }
                        className="w-full"
                        style={{ accentColor: 'var(--primary-color)' }}
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs font-bold text-slate-500">
                        <span>بەری دەرس خلاس ببیت:</span>
                        <span className="font-black" style={{ color: 'var(--primary-color)' }}>
                          {alarmSettings.minutesBeforeEnd} خولەک
                        </span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="10"
                        value={alarmSettings.minutesBeforeEnd}
                        onChange={(e) =>
                          setAlarmSettings((p) => ({ ...p, minutesBeforeEnd: parseInt(e.target.value) }))
                        }
                        className="w-full"
                        style={{ accentColor: 'var(--primary-color)' }}
                      />
                    </div>
                  </div>

                  {/* Voice Gender */}
                  <div className="space-y-2">
                    <label className="text-xs font-black text-slate-400 uppercase tracking-widest">
                      ڕەگەزێ دەنگێ جەرەسی:
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        onClick={() => setVoiceGender('male')}
                        className={`flex items-center justify-center gap-2 py-3 rounded-2xl border-2 transition-all font-bold text-xs ${
                          voiceGender === 'male'
                            ? 'text-white shadow-md'
                            : 'bg-slate-50 border-slate-200 text-slate-600'
                        }`}
                        style={{
                          backgroundColor: voiceGender === 'male' ? 'var(--primary-color)' : '',
                          borderColor: voiceGender === 'male' ? 'var(--primary-color)' : '',
                        }}
                      >
                        <User className="w-4 h-4" /> دەنگێ زەلام
                      </button>
                      <button
                        onClick={() => setVoiceGender('female')}
                        className={`flex items-center justify-center gap-2 py-3 rounded-2xl border-2 transition-all font-bold text-xs ${
                          voiceGender === 'female'
                            ? 'text-white shadow-md'
                            : 'bg-slate-50 border-slate-200 text-slate-600'
                        }`}
                        style={{
                          backgroundColor: voiceGender === 'female' ? 'var(--primary-color)' : '',
                          borderColor: voiceGender === 'female' ? 'var(--primary-color)' : '',
                        }}
                      >
                        <UserCircle className="w-4 h-4" /> دەنگێ ژن
                      </button>
                    </div>
                  </div>

                  {/* Offline Audio Scripts */}
                  <div className="space-y-3">
                    <label className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
                      <Mic className="w-4 h-4" /> دەنگ و پەیامێن زەنگێ (Gemini TTS):
                    </label>
                    <div className="space-y-2">
                      {Object.entries(customScripts).slice(0, 7).map(([key, text]) => (
                        <div
                          key={key}
                          className={`p-3.5 rounded-2xl border transition-all ${
                            readyVoices.includes(key) ? 'border-green-200 bg-green-50/30' : 'border-slate-200 bg-white'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="font-black text-xs text-slate-800">
                              {key === 'end' ? 'کۆتاییا وانێ (خلاس بوون)' : `پۆلا ${key}`}
                            </span>
                            <div className="flex items-center gap-1">
                              {readyVoices.includes(key) && (
                                <button
                                  onClick={() => playOfflineVoice(key, 1)}
                                  className="p-1.5 bg-white text-green-600 rounded-lg border border-green-200 shadow-sm"
                                  title="پێکردن"
                                >
                                  <Play className="w-3.5 h-3.5" />
                                </button>
                              )}
                              <label
                                className="p-1.5 rounded-lg border bg-white text-blue-500 cursor-pointer hover:bg-blue-50 transition-all border-slate-200"
                                title="بارکرنا دەنگێ خو"
                              >
                                <Upload className="w-3.5 h-3.5" />
                                <input
                                  type="file"
                                  accept="audio/*"
                                  className="hidden"
                                  onChange={(e) => e.target.files && handleFileUpload(key, e.target.files[0])}
                                />
                              </label>
                              <button
                                onClick={() => setEditingScriptKey(editingScriptKey === key ? null : key)}
                                className={`p-1.5 rounded-lg border transition-all ${
                                  editingScriptKey === key ? 'text-white' : 'bg-white text-slate-400'
                                }`}
                                style={{
                                  backgroundColor: editingScriptKey === key ? 'var(--primary-color)' : '',
                                }}
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                          {editingScriptKey === key ? (
                            <div className="space-y-2 mt-2">
                              <textarea
                                value={text}
                                onChange={(e) => updateScript(key, e.target.value)}
                                className="w-full text-xs p-2.5 border-2 bg-white rounded-xl outline-none"
                                style={{ borderColor: 'var(--primary-color)' }}
                              />
                              <button
                                onClick={() => generateAndStoreVoice(key, text)}
                                disabled={generatingId !== null}
                                className="w-full flex items-center justify-center gap-2 text-white py-2 rounded-xl text-xs font-bold shadow-sm disabled:opacity-50"
                                style={{ backgroundColor: 'var(--primary-color)' }}
                              >
                                {generatingId === key ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <DownloadCloud className="w-3.5 h-3.5" />
                                )}
                                <span>دروستکرنا دەنگی ب Gemini AI</span>
                              </button>
                            </div>
                          ) : (
                            <p className="text-[11px] text-slate-400 line-clamp-1">{text}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 5: GENERAL & THEME */}
              {settingsActiveTab === 'general' && (
                <div className="space-y-6">
                  {/* Themes */}
                  <div className="space-y-2">
                    <label className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-1.5">
                      <Palette className="w-4 h-4" /> ڕەنگێ بەرنامەی:
                    </label>
                    <div className="flex flex-wrap gap-3 p-2 bg-slate-50 rounded-2xl border border-slate-200">
                      {THEMES.map((theme) => (
                        <button
                          key={theme.id}
                          onClick={() => setActiveTheme(theme)}
                          className={`w-9 h-9 rounded-full border-4 transition-all ${
                            activeTheme.id === theme.id ? 'scale-125 border-slate-300 shadow-md' : 'border-transparent'
                          }`}
                          style={{ backgroundColor: theme.color }}
                          title={theme.label}
                        />
                      ))}
                    </div>
                  </div>

                  {/* Change Selected Teacher Profile */}
                  <div className="p-4 bg-indigo-50/80 rounded-3xl border border-indigo-200 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="text-right">
                        <span className="font-black text-xs text-indigo-950 block">پڕۆفایلی مامۆستای هەڵبژێردراو:</span>
                        <span className="font-bold text-xs text-indigo-700">{teacherName} ({teacherSubject})</span>
                      </div>
                      <button
                        onClick={() => {
                          setShowSettingsModal(false);
                          setShowTeacherSelectModal(true);
                        }}
                        className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-black text-xs shadow-md transition-all active:scale-95"
                      >
                        گۆڕینی مامۆستا
                      </button>
                    </div>
                  </div>

                  {/* Kurdish Alphabet Expansion for all grades */}
                  <div className="p-4 bg-gradient-to-r from-indigo-50 to-purple-50 rounded-3xl border-2 border-indigo-200 shadow-xs space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="p-2.5 bg-indigo-600 text-white rounded-2xl shadow-sm">
                          <Layers className="w-5 h-5 text-yellow-300" />
                        </div>
                        <div>
                          <h4 className="font-black text-xs text-indigo-950">هەموو پیتێن ئەلفوبێیا کوردی بۆ هەمی قۆناغان (10، 11، 12)</h4>
                          <p className="text-[11px] text-indigo-700">بە دیفۆڵت هۆبەکان تا پیتێ (ز) بەردەستن. بە چالاککردنی، هەموو 34 پیتە کوردییەکان بەردەست دەبن.</p>
                        </div>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={alarmSettings.allKurdishLettersEnabled || false}
                          onChange={(e) => {
                            const updated: AlarmSettings = {
                              ...alarmSettings,
                              allKurdishLettersEnabled: e.target.checked
                            };
                            setAlarmSettings(updated);
                            try {
                              localStorage.setItem('alarm_settings_v10', JSON.stringify(updated));
                              saveBackupData('alarm_settings_v10', updated);
                            } catch (err) {}
                          }}
                          className="sr-only peer"
                        />
                        <div className="w-12 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:right-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                      </label>
                    </div>
                    <div className="flex flex-wrap gap-1 p-2.5 bg-white/80 rounded-2xl border border-indigo-100 max-h-24 overflow-y-auto no-scrollbar">
                      {(alarmSettings.allKurdishLettersEnabled ? ALL_KURDISH_SECTIONS : STANDARD_SECTIONS).map(s => (
                        <span key={s} className="px-2 py-0.5 bg-indigo-100 text-indigo-900 text-[11px] font-black rounded-lg">
                          {s}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="space-y-2">
                    <button
                      onClick={stopAllAudio}
                      className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl text-white font-bold text-xs shadow-md bg-red-500 hover:bg-red-600 active:scale-95 transition-all"
                    >
                      <VolumeX className="w-4 h-4" /> ڕاوەستاندنا هەمی دەنگان (Stop Audio)
                    </button>
                    {deferredPrompt && (
                      <button
                        onClick={handleInstallClick}
                        className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl text-white font-bold text-xs shadow-md active:scale-95 transition-all"
                        style={{ backgroundColor: 'var(--primary-color)' }}
                      >
                        <Download className="w-4 h-4" /> دابەزاندنا بەرنامەی بۆ مۆبایلێ (Install App)
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* TAB 6: LOCALSTORAGE & PWA DOWNLOAD */}
              {settingsActiveTab === 'storage' && (
                <div className="space-y-6">
                  {/* Status Banner */}
                  <div className="p-4 bg-cyan-50 rounded-3xl border border-cyan-200 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 font-black text-sm text-cyan-950">
                        <HardDrive className="w-5 h-5 text-cyan-700" />
                        <span>دۆخی بیرگەی وێبگەڕ (LocalStorage)</span>
                      </div>
                      <span className="text-[10px] font-black bg-cyan-200 text-cyan-900 px-2.5 py-0.5 rounded-full">
                        چالاکە
                      </span>
                    </div>
                    <p className="text-xs text-cyan-800 leading-relaxed font-medium">
                      هەموو گۆڕانکاری و خشتە و کاتەکانت ڕاستەوخۆ لە بیرگەی ناوخۆیی وێبگەڕ (LocalStorage) پارێزراون و پێویستی بە ئینتەرنێت نییە.
                    </p>
                  </div>

                  {/* PWA App Download Card */}
                  <div className="p-5 bg-gradient-to-r from-indigo-900 to-purple-900 text-white rounded-3xl space-y-3 shadow-lg">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <div className="p-2.5 bg-white/10 rounded-2xl">
                          <Download className="w-5 h-5 text-yellow-300" />
                        </div>
                        <div>
                          <h4 className="font-black text-sm">دابەزاندنا ئەپێ بۆ سەر مۆبایل (PWA)</h4>
                          <p className="text-[11px] text-indigo-200">
                            {isStandalone ? "ئەپەکە پێشتر دابەزێنراوە (Installed)" : "وەک ئەپێکی سەربەخۆ دابەزێنە"}
                          </p>
                        </div>
                      </div>
                    </div>

                    <button
                      onClick={triggerInstallApp}
                      className="w-full py-3.5 rounded-2xl bg-white text-indigo-950 font-black text-xs hover:bg-yellow-300 transition-all flex items-center justify-center gap-2 shadow-md active:scale-95"
                    >
                      <Download className="w-4 h-4 text-indigo-600" />
                      <span>{isStandalone ? "بەرنامەکە پێشتر دابەزێنراوە ✓" : "دابەزاندنا ئەپێ (Install App Now)"}</span>
                    </button>
                  </div>

                  {/* Export & Import Backup */}
                  <div className="space-y-3">
                    <label className="text-xs font-black text-slate-500 uppercase tracking-widest flex items-center gap-1.5">
                      <FileJson className="w-4 h-4" /> فایلی یەدەگ (Backup & Restore):
                    </label>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {/* Export button */}
                      <button
                        onClick={exportLocalStorageBackup}
                        className="p-4 rounded-2xl border-2 border-slate-200 bg-slate-50 hover:bg-slate-100 flex flex-col items-center justify-center gap-1.5 text-center font-bold text-xs text-slate-700 transition-all active:scale-95"
                      >
                        <ArrowDownToLine className="w-5 h-5 text-indigo-600" />
                        <span>داگرتنا کۆپییا یەدەگ</span>
                        <span className="text-[10px] text-slate-400 font-normal">وەک فایلی JSON بۆ ناو ئامێرەکەت</span>
                      </button>

                      {/* Import file label */}
                      <label className="p-4 rounded-2xl border-2 border-dashed border-indigo-200 bg-indigo-50/50 hover:bg-indigo-50 flex flex-col items-center justify-center gap-1.5 text-center font-bold text-xs text-indigo-900 cursor-pointer transition-all active:scale-95">
                        <FolderUp className="w-5 h-5 text-indigo-600" />
                        <span>بارکردنی فایلی یەدەگ</span>
                        <span className="text-[10px] text-indigo-600/70 font-normal">هەڵبژاردنی فایلی JSON</span>
                        <input
                          type="file"
                          accept=".json,application/json"
                          className="hidden"
                          onChange={(e) => e.target.files && importLocalStorageBackup(e.target.files[0])}
                        />
                      </label>
                    </div>
                  </div>

                  {/* Reset Storage */}
                  <div className="pt-2 border-t border-slate-100">
                    <button
                      onClick={resetLocalStorageData}
                      className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl border border-red-200 text-red-600 hover:bg-red-50 text-xs font-bold transition-all"
                    >
                      <Trash2 className="w-4 h-4" />
                      <span>خاوێنکردنەوە و ڕێسێتی LocalStorage</span>
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="p-4 bg-slate-50 border-t flex gap-2">
              <button
                onClick={() => {
                  saveToLocal();
                  setShowSettingsModal(false);
                }}
                className="w-full text-white py-3.5 rounded-2xl font-black text-xs shadow-lg transition-all"
                style={{ backgroundColor: 'var(--primary-color)' }}
              >
                پاشکەفتن و داخستن
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Teacher Profile Selection Modal */}
      {showTeacherSelectModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 backdrop-blur-md p-4">
          <div className="bg-white rounded-[2.5rem] max-w-lg w-full shadow-2xl overflow-hidden flex flex-col max-h-[90vh] border border-slate-100 animate-in zoom-in-95 duration-200">
            {/* Header */}
            <div className="p-6 bg-gradient-to-r from-indigo-900 via-purple-900 to-slate-900 text-white flex justify-between items-center">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-white/10 rounded-2xl backdrop-blur-sm">
                  <UserCircle className="w-6 h-6 text-yellow-300" />
                </div>
                <div>
                  <h3 className="font-black text-lg">مامۆستا، ناڤێ خۆ هەڵبژێرە</h3>
                  <p className="text-xs text-indigo-200">دەتوا‌نیت ناڤێ خۆ دیاری بکەی دا جەتوەلا تە بەردەوام ل بەر شاشەی بێت</p>
                  <div className="flex items-center gap-1.5 mt-1.5">
                    <span className="text-[10px] font-black bg-emerald-500/30 text-emerald-200 border border-emerald-400/30 px-2.5 py-0.5 rounded-full flex items-center gap-1">
                      <CheckCircle className="w-3 h-3 text-emerald-300" />
                      <span>{allTeachersList.length} جەتوەلێن مامۆستایان ئۆفلاین ئامادەن (100% Offline Ready)</span>
                    </span>
                  </div>
                </div>
              </div>
              {localStorage.getItem('selected_teacher_id') && (
                <button
                  onClick={() => setShowTeacherSelectModal(false)}
                  className="p-2 hover:bg-white/10 rounded-full text-slate-300"
                >
                  <X className="w-5 h-5" />
                </button>
              )}
            </div>

            {/* Search Input & Grade / Section Filters */}
            <div className="p-4 border-b bg-slate-50 space-y-3">
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute right-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={teacherSearchTerm}
                  onChange={(e) => setTeacherSearchTerm(e.target.value)}
                  placeholder="🔍 بگەڕێ بۆ ناڤێ خۆ یان بابەتی خۆ..."
                  className="w-full text-xs p-3 pr-10 bg-white border border-slate-200 rounded-2xl outline-none focus:border-indigo-600 font-bold"
                />
              </div>

              {/* Grade & Section Filters */}
              <div className="grid grid-cols-2 gap-2 text-xs font-bold">
                <div>
                  <label className="text-[11px] text-slate-500 block mb-1">سەف / قۆناغ (Grade):</label>
                  <select
                    value={selectedGradeFilter}
                    onChange={(e) => setSelectedGradeFilter(e.target.value)}
                    className="w-full p-2 bg-white border border-slate-200 rounded-xl outline-none font-bold text-slate-700"
                  >
                    <option value="all">هەموو قۆناغەکان (All Grades)</option>
                    <option value="10">پۆلا 10</option>
                    <option value="11">پۆلا 11</option>
                    <option value="12">پۆلا 12</option>
                    <option value="1">پۆلا 1</option>
                    <option value="2">پۆلا 2</option>
                    <option value="3">پۆلا 3</option>
                    <option value="4">پۆلا 4</option>
                    <option value="5">پۆلا 5</option>
                    <option value="6">پۆلا 6</option>
                    <option value="7">پۆلا 7</option>
                    <option value="8">پۆلا 8</option>
                    <option value="9">پۆلا 9</option>
                  </select>
                </div>

                <div>
                  <label className="text-[11px] text-slate-500 block mb-1">هۆبە / بەش (Section):</label>
                  <select
                    value={selectedSectionFilter}
                    onChange={(e) => setSelectedSectionFilter(e.target.value)}
                    className="w-full p-2 bg-white border border-slate-200 rounded-xl outline-none font-bold text-slate-700"
                  >
                    <option value="all">هەموو هۆبەکان (All Sections)</option>
                    {getActiveSections(alarmSettings.allKurdishLettersEnabled).map(sec => (
                      <option key={sec} value={sec}>هۆبەیا ({sec})</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* List of Teachers */}
            <div className="p-4 overflow-y-auto space-y-2 max-h-[60vh] no-scrollbar">
              {allTeachersList
                .filter(t => {
                  const matchesSearch = t.teacherName.toLowerCase().includes(teacherSearchTerm.toLowerCase()) || 
                                        t.subject.toLowerCase().includes(teacherSearchTerm.toLowerCase());
                  const schedStr = JSON.stringify(t.schedule);
                  const matchesGrade = selectedGradeFilter === 'all' || schedStr.includes(selectedGradeFilter);
                  const matchesSection = selectedSectionFilter === 'all' || schedStr.includes(`- ${selectedSectionFilter}`) || schedStr.includes(selectedSectionFilter);
                  return matchesSearch && matchesGrade && matchesSection;
                })
                .map((tDoc) => {
                  const isSelected = selectedTeacherId === tDoc.id || selectedTeacherId === tDoc.teacherName;
                  return (
                    <div
                      key={tDoc.id}
                      onClick={() => selectTeacherProfile(tDoc)}
                      className={`p-4 rounded-2xl border transition-all cursor-pointer flex items-center justify-between ${
                        isSelected
                          ? 'bg-indigo-600 text-white border-indigo-600 shadow-md scale-[1.02]'
                          : 'bg-white hover:bg-slate-50 border-slate-200 text-slate-800'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`p-2.5 rounded-xl font-black text-sm ${isSelected ? 'bg-white/20 text-white' : 'bg-indigo-50 text-indigo-700'}`}>
                          <User className="w-5 h-5" />
                        </div>
                        <div className="text-right">
                          <h4 className="font-black text-sm">{tDoc.teacherName}</h4>
                          <p className={`text-xs font-medium ${isSelected ? 'text-indigo-100' : 'text-slate-500'}`}>
                            بابەت: {tDoc.subject || 'گشتی'}
                          </p>
                        </div>
                      </div>

                      {isSelected ? (
                        <span className="text-xs font-black bg-white/20 px-3 py-1 rounded-full flex items-center gap-1">
                          <Check className="w-4 h-4" /> هەڵبژێردراوە
                        </span>
                      ) : (
                        <span className="text-xs font-bold text-indigo-600 bg-indigo-50 px-3 py-1 rounded-full hover:bg-indigo-100">
                          هەڵبژارتن ↗
                        </span>
                      )}
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      )}

      {/* Smart Period Swap Modal */}
      {showSwapModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 backdrop-blur-md p-4">
          <div className="bg-white rounded-[2.5rem] max-w-2xl w-full shadow-2xl overflow-hidden flex flex-col max-h-[92vh] border border-slate-100">
            {/* Header */}
            <div className="p-6 bg-gradient-to-r from-cyan-900 via-indigo-900 to-purple-900 text-white flex justify-between items-center">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-white/10 rounded-2xl backdrop-blur-sm">
                  <Shuffle className="w-6 h-6 text-cyan-300" />
                </div>
                <div>
                  <h3 className="font-black text-lg">یاریدەدەرێ گۆڕینەوەیا وانان دگەل مامۆستایان</h3>
                  <p className="text-xs text-cyan-200">گۆڕینەوەی ئۆتۆماتیکیی 1 یان 2 مامۆستایان بەبێ تێکچوونی خشتە</p>
                </div>
              </div>
              <button onClick={() => setShowSwapModal(false)} className="p-2 hover:bg-white/10 rounded-full text-slate-300">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 space-y-6 overflow-y-auto no-scrollbar">
              {/* Swap Selection Controls with Grade & Section (پۆل و هۆبە) */}
              <div className="space-y-4 bg-slate-50 p-5 rounded-3xl border border-slate-200 text-xs">
                {/* Detected Class & Offline Search Status Bar */}
                {(() => {
                  const activeDoc = allTeachersList.find(t => t.id === selectedTeacherId || t.teacherName === selectedTeacherId);
                  const sourceSlot = activeDoc?.schedule[swapSourceDay]?.slots?.[swapSourceLessonIndex];
                  const rawClass = sourceSlot?.className || 'بێ وانە';
                  const parsed = parseClassAndSection(rawClass);
                  const activeGradeLabel = (swapSelectedGrade && swapSelectedGrade !== 'auto') ? `پۆلا ${swapSelectedGrade}` : parsed.grade;
                  const activeSectionLabel = (swapSelectedSection && swapSelectedSection !== 'auto') ? `هۆبەیا (${swapSelectedSection})` : parsed.section;

                  return (
                    <div className="p-3.5 rounded-2xl bg-indigo-900 text-white flex flex-wrap items-center justify-between gap-2 shadow-sm">
                      <div className="flex items-center gap-2">
                        <span className="text-yellow-400 font-black text-sm">📌 پۆل و هۆبەیا دەستنیشانکری:</span>
                        <span className="font-extrabold text-sm bg-white/20 px-3 py-1 rounded-xl text-yellow-200 border border-white/20">
                          {activeGradeLabel} — {activeSectionLabel}
                        </span>
                      </div>
                      <span className="text-[10px] font-black bg-emerald-500/20 text-emerald-300 border border-emerald-400/40 px-2.5 py-0.5 rounded-full flex items-center gap-1">
                        <WifiOff className="w-3 h-3 text-emerald-400" /> سێرچا ئۆفلاین (100% Offline Local Search)
                      </span>
                    </div>
                  );
                })()}

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {/* Day Picker */}
                  <div>
                    <label className="font-black text-slate-700 block mb-1.5">ڕۆژ هەڵبژێرە:</label>
                    <select
                      value={swapSourceDay}
                      onChange={(e) => setSwapSourceDay(e.target.value)}
                      className="w-full p-2.5 bg-white border border-slate-300 rounded-xl font-bold outline-none focus:border-indigo-600"
                    >
                      {DAYS.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>

                  {/* Source Lesson Picker */}
                  <div>
                    <label className="font-black text-slate-700 block mb-1.5">وانەی سەرەکی (دەرمەبەست):</label>
                    <select
                      value={swapSourceLessonIndex}
                      onChange={(e) => setSwapSourceLessonIndex(parseInt(e.target.value))}
                      className="w-full p-2.5 bg-white border border-slate-300 rounded-xl font-bold outline-none focus:border-indigo-600"
                    >
                      {Array.from({ length: alarmSettings.lessonCount || 6 }).map((_, i) => (
                        <option key={i} value={i}>وانا {i + 1}</option>
                      ))}
                    </select>
                  </div>

                  {/* Target Lesson Picker */}
                  <div>
                    <label className="font-black text-slate-700 block mb-1.5">دەستبکە بە گوڕین بۆ وانەی:</label>
                    <select
                      value={swapTargetLessonIndex}
                      onChange={(e) => setSwapTargetLessonIndex(parseInt(e.target.value))}
                      className="w-full p-2.5 bg-white border border-slate-300 rounded-xl font-bold outline-none focus:border-indigo-600"
                    >
                      {Array.from({ length: alarmSettings.lessonCount || 6 }).map((_, i) => (
                        <option key={i} value={i}>وانا {i + 1}</option>
                      ))}
                    </select>
                  </div>

                  {/* Grade Picker (پۆل) */}
                  <div>
                    <label className="font-black text-slate-700 block mb-1.5">چ پۆل (Grade):</label>
                    <select
                      value={swapSelectedGrade}
                      onChange={(e) => setSwapSelectedGrade(e.target.value)}
                      className="w-full p-2.5 bg-white border border-indigo-200 rounded-xl font-bold outline-none focus:border-indigo-600 text-indigo-900"
                    >
                      <option value="auto">✨ ئۆتۆماتیکی (ژ وانەیێ خۆ دیاربکە)</option>
                      <option value="10">پۆلا 10</option>
                      <option value="11">پۆلا 11</option>
                      <option value="12">پۆلا 12</option>
                      <option value="1">پۆلا 1</option>
                      <option value="2">پۆلا 2</option>
                      <option value="3">پۆلا 3</option>
                      <option value="4">پۆلا 4</option>
                      <option value="5">پۆلا 5</option>
                      <option value="6">پۆلا 6</option>
                      <option value="7">پۆلا 7</option>
                      <option value="8">پۆلا 8</option>
                      <option value="9">پۆلا 9</option>
                    </select>
                  </div>

                  {/* Section Picker (هۆبە) */}
                  <div className="sm:col-span-2 lg:col-span-4">
                    <label className="font-black text-slate-700 block mb-1.5">چ هۆبە (Section):</label>
                    <select
                      value={swapSelectedSection}
                      onChange={(e) => setSwapSelectedSection(e.target.value)}
                      className="w-full p-2.5 bg-white border border-purple-200 rounded-xl font-bold outline-none focus:border-purple-600 text-purple-900"
                    >
                      <option value="auto">✨ ئۆتۆماتیکی (نەفسی هۆبەیا وانەیێ خۆ)</option>
                      {getActiveSections(alarmSettings.allKurdishLettersEnabled).map(sec => (
                        <option key={sec} value={sec}>هۆبەیا ({sec})</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* Suggestions Results */}
              <div className="space-y-4">
                {swapSuggestions.length === 0 ? (
                  <div className="p-8 text-center text-slate-400 font-medium text-xs bg-slate-50 rounded-3xl border border-dashed border-slate-200 space-y-2">
                    <p className="font-black text-slate-600 text-sm">هیچ پێشنیارێکی گۆڕینەوەی گونجاو نەدۆزرایەوە!</p>
                    <p className="text-slate-400">تکایە دڵنیابەوە کە وانەی سەرەکی بەتاڵ نییە، یان هەمان پۆل و هۆبە تاقیبکەوە.</p>
                  </div>
                ) : (
                  swapSuggestions.map((sug) => (
                    <div key={sug.id} className="p-6 rounded-[2rem] bg-gradient-to-br from-indigo-50/90 via-purple-50/50 to-white border-2 border-indigo-200/80 space-y-4 shadow-md text-right relative overflow-hidden">
                      {/* Header Badge */}
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3 border-indigo-100">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-black px-3.5 py-1 rounded-full text-white shadow-xs ${
                            sug.type === 'direct'
                              ? 'bg-emerald-600'
                              : sug.type === 'chain'
                              ? 'bg-indigo-600'
                              : 'bg-purple-700'
                          }`}>
                            {sug.type === 'direct'
                              ? '⚡ گۆڕینەوەی ڕاستەوخۆ (1 مامۆستا)'
                              : sug.type === 'chain'
                              ? '🔗 گۆڕینەوەی زنجیرەیی (2 مامۆستا)'
                              : '🧩 گۆڕینەوەی فرە-زنجیرەیی (3 یان 4 مامۆستا)'}
                          </span>
                          <span className="text-xs font-black text-indigo-900 bg-white border border-indigo-200 px-3 py-0.5 rounded-full">
                            {sug.teacherCount} مامۆستا بەشدارن
                          </span>
                        </div>
                        <span className="text-xs font-extrabold text-indigo-900 bg-indigo-100 px-3 py-1 rounded-full">
                          پۆل و هۆبە: {sug.classNameToMove}
                        </span>
                      </div>

                      {/* Title & Description */}
                      <p className="text-xs font-black text-indigo-950 leading-relaxed">
                        {sug.detailsKurdish}
                      </p>

                      {/* Visual Step-by-Step Flow Cards */}
                      <div className="space-y-2.5 pt-1">
                        <h5 className="text-[11px] font-black text-slate-500 uppercase tracking-wider">
                          📋 نەخشەی هەنگاو بە هەنگاوی گۆڕینەوەکە (Step-by-Step Flow):
                        </h5>
                        <div className="space-y-2">
                          {sug.steps.map((st) => (
                            <div
                              key={st.stepNumber}
                              className="p-3.5 rounded-2xl bg-white border border-indigo-100 shadow-xs flex items-center justify-between gap-3 text-xs font-bold"
                            >
                              <div className="flex items-center gap-3">
                                <div className="w-7 h-7 rounded-xl bg-indigo-600 text-white font-black text-xs flex items-center justify-center shadow-xs flex-shrink-0">
                                  {st.stepNumber}
                                </div>
                                <div>
                                  <div className="font-black text-slate-800 text-xs flex items-center gap-2">
                                    <span>م. {st.teacherName} ({st.subject})</span>
                                    <span className="text-[10px] bg-indigo-50 text-indigo-700 font-extrabold px-2 py-0.5 rounded-md">
                                      وانا {st.fromLesson} ➔ وانا {st.toLesson}
                                    </span>
                                  </div>
                                  <p className="text-[11px] text-slate-600 font-medium mt-0.5 leading-snug">
                                    {st.actionKurdish}
                                  </p>
                                </div>
                              </div>
                              <span className="text-[10px] font-black text-purple-700 bg-purple-50 border border-purple-200 px-2.5 py-1 rounded-xl flex-shrink-0">
                                {st.className}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Execute Swap Button */}
                      <button
                        onClick={() => applySwapToDatabase(sug)}
                        disabled={swapExecutingId === sug.id}
                        className="w-full py-4 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs shadow-xl flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-50 mt-2"
                      >
                        {swapExecutingId === sug.id ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-5 h-5 text-yellow-300" />}
                        <span>🚀 جێبەجێکرنا هەموو هەنگاوان د داتابێسا Firebase دا (Apply Flow to All)</span>
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Admin Panel & Mass Import/Export Modal */}
      {showAdminModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 backdrop-blur-md p-4">
          <div className="bg-white rounded-[2.5rem] max-w-4xl w-full shadow-2xl overflow-hidden flex flex-col max-h-[94vh] border border-slate-100">
            {/* Header */}
            <div className="p-6 bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white flex justify-between items-center">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-yellow-400 text-slate-950 rounded-2xl shadow-md">
                  <ShieldCheck className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="font-black text-lg">بەشی بەڕێوەبەرایەتی و ئەدمین (Admin Control Panel)</h3>
                  <p className="text-xs text-slate-300">بارکرن و بەڵاڤکرنا بە کۆم بۆ هەموو جەتوەلێن قوتابخانێ</p>
                </div>
              </div>
              <button onClick={() => setShowAdminModal(false)} className="p-2 hover:bg-white/10 rounded-full text-slate-300">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Admin PIN Login Lock */}
            {!isAdminLoggedIn ? (
              <div className="p-8 space-y-4 max-w-md mx-auto text-center">
                <div className="w-16 h-16 bg-yellow-100 text-yellow-700 rounded-full flex items-center justify-center mx-auto">
                  <Lock className="w-8 h-8" />
                </div>
                <h4 className="font-black text-slate-800 text-base">کۆدی تێپەڕبوونی ئەدمین لێبدە</h4>
                <p className="text-xs text-slate-500 font-medium">تەنها ئەدمینی تایبەتی قوتابخانێ دەتوانێت بچێتە ژوورەوە</p>

                <input
                  type="password"
                  value={adminPinInput}
                  onChange={(e) => setAdminPinInput(e.target.value)}
                  placeholder="کۆدی تێپەڕبوون بنڤێسە..."
                  className="w-full text-center text-lg p-3 bg-slate-50 border-2 border-slate-200 rounded-2xl font-mono tracking-widest outline-none focus:border-yellow-500"
                />

                {adminPinError && (
                  <p className="text-xs font-bold text-red-600 bg-red-50 p-2 rounded-xl">{adminPinError}</p>
                )}

                <button
                  onClick={() => {
                    if (adminPinInput === '2026' || adminPinInput === 'admin') {
                      setIsAdminLoggedIn(true);
                      setAdminPinError(null);
                    } else {
                      setAdminPinError("کۆدی ئەدمین خەلەتە!");
                    }
                  }}
                  className="w-full py-3.5 rounded-2xl bg-yellow-400 hover:bg-yellow-500 text-slate-950 font-black text-xs shadow-md transition-all active:scale-95"
                >
                  چوونە ژوورەوە وەک ئەدمین
                </button>
              </div>
            ) : (
              <div className="p-6 space-y-6 overflow-y-auto no-scrollbar">
                {/* Actions & Backup Download */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    onClick={handleExportAllJson}
                    className="p-4 rounded-2xl bg-indigo-50 border-2 border-indigo-200 text-indigo-900 font-black text-xs flex items-center justify-center gap-2 hover:bg-indigo-100 transition-all active:scale-95"
                  >
                    <DownloadCloud className="w-5 h-5 text-indigo-600" />
                    <span>داگرتنا هەموو جەتوەلان وەک فایلی کۆد (JSON Export)</span>
                  </button>

                  <div className="flex items-center justify-between p-4 bg-emerald-50 rounded-2xl border border-emerald-200 text-emerald-900 text-xs font-bold">
                    <span>ژمارەی جەتوەلە بەردەستەکان د داتابێسدا:</span>
                    <span className="font-black text-sm bg-emerald-600 text-white px-3 py-1 rounded-xl">
                      {allTeachersList.length} مامۆستا
                    </span>
                  </div>
                </div>

                {/* Admin Tabs */}
                <div className="space-y-4 bg-slate-50 p-5 rounded-3xl border border-slate-200">
                  <div className="flex flex-wrap border-b pb-2 gap-2 text-xs font-black">
                    <button
                      onClick={() => setAdminImportTab('edit')}
                      className={`px-4 py-2.5 rounded-xl transition-all flex items-center gap-1.5 ${adminImportTab === 'edit' ? 'bg-indigo-600 text-white shadow-md' : 'bg-white text-slate-600 hover:bg-slate-200'}`}
                    >
                      <Edit3 className="w-4 h-4 text-yellow-300" />
                      <span>١. دەستکاریکرنی جەتوەلا مامۆستایان</span>
                    </button>
                    <button
                      onClick={() => setAdminImportTab('requests')}
                      className={`px-4 py-2.5 rounded-xl transition-all flex items-center gap-1.5 relative ${adminImportTab === 'requests' ? 'bg-indigo-600 text-white shadow-md' : 'bg-white text-slate-600 hover:bg-slate-200'}`}
                    >
                      <Layers className="w-4 h-4 text-yellow-300" />
                      <span>٢. داخوازیێن دەستکاریێ</span>
                      {changeRequests.filter(r => r.status === 'pending').length > 0 && (
                        <span className="bg-red-500 text-white text-[10px] px-2 py-0.5 rounded-full font-black animate-pulse">
                          {changeRequests.filter(r => r.status === 'pending').length} نوێ
                        </span>
                      )}
                    </button>
                    <button
                      onClick={() => setAdminImportTab('timings')}
                      className={`px-4 py-2.5 rounded-xl transition-all flex items-center gap-1.5 ${adminImportTab === 'timings' ? 'bg-indigo-600 text-white shadow-md' : 'bg-white text-slate-600 hover:bg-slate-200'}`}
                    >
                      <Clock className="w-4 h-4 text-yellow-300" />
                      <span>٣. وەختێت دەوامێ، جەرەس و انتیحانێ</span>
                    </button>
                    <button
                      onClick={() => setAdminImportTab('sections')}
                      className={`px-4 py-2.5 rounded-xl transition-all flex items-center gap-1.5 ${adminImportTab === 'sections' ? 'bg-indigo-600 text-white shadow-md' : 'bg-white text-slate-600 hover:bg-slate-200'}`}
                    >
                      <Building2 className="w-4 h-4 text-yellow-300" />
                      <span>٤. پیتێن هۆبان (Section Letters)</span>
                    </button>
                    <button
                      onClick={() => setAdminImportTab('code')}
                      className={`px-4 py-2.5 rounded-xl transition-all flex items-center gap-1.5 ${adminImportTab === 'code' ? 'bg-indigo-600 text-white shadow-md' : 'bg-white text-slate-600 hover:bg-slate-200'}`}
                    >
                      <FileJson className="w-4 h-4" />
                      <span>٥. داخلکردنی فایلی کۆد / JSON</span>
                    </button>
                    <button
                      onClick={() => setAdminImportTab('file')}
                      className={`px-4 py-2.5 rounded-xl transition-all flex items-center gap-1.5 ${adminImportTab === 'file' ? 'bg-indigo-600 text-white shadow-md' : 'bg-white text-slate-600 hover:bg-slate-200'}`}
                    >
                      <Upload className="w-4 h-4" />
                      <span>٦. بارکردنی فایلی PDF / وێنە</span>
                    </button>
                  </div>

                  {/* TAB 1: INTERACTIVE 1-CLICK TEACHER EDITOR */}
                  {adminImportTab === 'edit' && (
                    <div className="space-y-5">
                      {!adminEditingTeacher ? (
                        <div className="space-y-4">
                          <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
                            <div className="relative flex-1 w-full">
                              <Search className="w-4 h-4 text-slate-400 absolute right-3.5 top-1/2 -translate-y-1/2" />
                              <input
                                type="text"
                                value={adminTeacherSearch}
                                onChange={(e) => setAdminTeacherSearch(e.target.value)}
                                placeholder="🔍 بگەڕێ بۆ ناڤێ مامۆستایەکێ بۆ دەستکاریکرن..."
                                className="w-full text-xs p-3 pr-10 bg-white border border-slate-200 rounded-2xl outline-none font-bold text-slate-800 focus:border-indigo-600"
                              />
                            </div>
                            <button
                              onClick={handleAdminAddNewTeacher}
                              className="w-full sm:w-auto px-5 py-3 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs shadow-md flex items-center justify-center gap-2 transition-all active:scale-95"
                            >
                              <Plus className="w-4 h-4" />
                              <span>زێدەکرنا مامۆستایەکێ نوی</span>
                            </button>
                          </div>

                          {/* List of Teachers to Edit with 1-Click */}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-[55vh] overflow-y-auto pr-1 no-scrollbar">
                            {allTeachersList
                              .filter(t => t.teacherName.toLowerCase().includes(adminTeacherSearch.toLowerCase()) || t.subject.toLowerCase().includes(adminTeacherSearch.toLowerCase()))
                              .map((tDoc) => (
                                <div
                                  key={tDoc.id}
                                  className="p-4 rounded-2xl bg-white border border-slate-200 hover:border-indigo-300 shadow-xs flex items-center justify-between gap-3 transition-all"
                                >
                                  <div className="flex items-center gap-3">
                                    <div className="p-3 bg-indigo-50 text-indigo-700 rounded-xl font-black">
                                      <User className="w-5 h-5" />
                                    </div>
                                    <div>
                                      <h4 className="font-black text-sm text-slate-800">{tDoc.teacherName}</h4>
                                      <span className="text-xs text-indigo-600 font-bold bg-indigo-50 px-2 py-0.5 rounded-full">
                                        بابەت: {tDoc.subject || 'کیمیا'}
                                      </span>
                                    </div>
                                  </div>

                                  <div className="flex items-center gap-2">
                                    <button
                                      onClick={() => handleAdminStartEditTeacher(tDoc)}
                                      className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-black text-xs shadow-sm flex items-center gap-1.5 active:scale-95 transition-all"
                                    >
                                      <Edit3 className="w-3.5 h-3.5 text-yellow-300" />
                                      <span>تەعدیلکرن</span>
                                    </button>
                                    <button
                                      onClick={() => handleAdminDeleteTeacher(tDoc)}
                                      className="p-2 rounded-xl bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 transition-all"
                                      title="سڕینەوە"
                                    >
                                      <Trash2 className="w-4 h-4" />
                                    </button>
                                  </div>
                                </div>
                              ))}
                          </div>
                        </div>
                      ) : (
                        /* INLINE INTERACTIVE MATRIX EDITOR */
                        <div className="p-5 rounded-3xl bg-white border-2 border-indigo-200 shadow-lg space-y-5 animate-in fade-in duration-200">
                          <div className="flex items-center justify-between border-b pb-4 border-slate-200">
                            <div className="flex items-center gap-2">
                              <div className="p-2.5 bg-indigo-600 text-white rounded-xl shadow-md">
                                <Edit3 className="w-5 h-5" />
                              </div>
                              <div>
                                <h3 className="font-black text-base text-slate-800">تەعدیل و دەستکاریکرنی جەتوەلی:</h3>
                                <p className="text-xs text-slate-500 font-medium">پاش دەستکاریکرن، ب کلیکەکێ بۆ هەمووان خەزن دبيت</p>
                              </div>
                            </div>
                            <button
                              onClick={() => setAdminEditingTeacher(null)}
                              className="p-2 hover:bg-slate-100 rounded-full text-slate-400"
                            >
                              <X className="w-5 h-5" />
                            </button>
                          </div>

                          {/* Editable Teacher Info */}
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                              <label className="text-xs font-black text-slate-700 block mb-1">ناڤێ مامۆستای:</label>
                              <input
                                type="text"
                                value={adminEditingName}
                                onChange={(e) => setAdminEditingName(e.target.value)}
                                className="w-full text-xs p-3 bg-slate-50 border border-slate-300 rounded-2xl outline-none font-bold text-slate-900 focus:border-indigo-600"
                              />
                            </div>
                            <div>
                              <label className="text-xs font-black text-slate-700 block mb-1">بابەت / دەرسا مامۆستای:</label>
                              <input
                                type="text"
                                value={adminEditingSubject}
                                onChange={(e) => setAdminEditingSubject(e.target.value)}
                                className="w-full text-xs p-3 bg-slate-50 border border-slate-300 rounded-2xl outline-none font-bold text-slate-900 focus:border-indigo-600"
                              />
                            </div>
                          </div>

                          {/* Matrix Table Editor */}
                          <div className="border border-slate-200 rounded-2xl overflow-x-auto shadow-xs">
                            <table className="w-full text-xs text-center border-collapse">
                              <thead>
                                <tr className="bg-indigo-900 text-white font-black border-b">
                                  <th className="p-3 border-l min-w-[100px]">ڕۆژ</th>
                                  {Array.from({ length: 6 }).map((_, i) => (
                                    <th key={i} className="p-3 border-l min-w-[110px]">
                                      وانا {i + 1}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {DAYS.map((dayName) => {
                                  const slots = adminEditingSchedule?.[dayName]?.slots || [];
                                  return (
                                    <tr key={dayName} className="border-b hover:bg-slate-50/80">
                                      <td className="p-3 font-black text-slate-800 bg-slate-100 border-l whitespace-nowrap">
                                        {dayName}
                                      </td>
                                      {Array.from({ length: 6 }).map((_, slotIdx) => {
                                        const currentVal = slots[slotIdx]?.className || 'بێ وانە';
                                        const activeSecs = getActiveSections(alarmSettings.allKurdishLettersEnabled);
                                        const standardOptions = [
                                          "بێ وانە",
                                          ...activeSecs.map(s => `10 - ${s}`),
                                          ...activeSecs.map(s => `11 - ${s}`),
                                          ...activeSecs.map(s => `12 - ${s}`)
                                        ];

                                        return (
                                          <td key={slotIdx} className="p-1.5 border-l">
                                            <div className="space-y-1">
                                              <select
                                                value={standardOptions.includes(currentVal) ? currentVal : 'custom'}
                                                onChange={(e) => {
                                                  if (e.target.value !== 'custom') {
                                                    handleAdminUpdateEditingCell(dayName, slotIdx, e.target.value);
                                                  }
                                                }}
                                                className={`w-full text-center py-1.5 px-1 rounded-xl font-extrabold text-xs outline-none border cursor-pointer ${
                                                  currentVal === 'بێ وانە'
                                                    ? 'bg-slate-100 text-slate-400 border-slate-200'
                                                    : 'bg-indigo-50 text-indigo-900 border-indigo-300 focus:ring-2 focus:ring-indigo-500'
                                                }`}
                                              >
                                                {standardOptions.map(opt => (
                                                  <option key={opt} value={opt}>{opt}</option>
                                                ))}
                                                <option value="custom">✍️ بنڤێسە (Custom)...</option>
                                              </select>

                                              {(!standardOptions.includes(currentVal) || currentVal === 'custom') && (
                                                <input
                                                  type="text"
                                                  value={currentVal === 'custom' ? '' : currentVal}
                                                  onChange={(e) => handleAdminUpdateEditingCell(dayName, slotIdx, e.target.value)}
                                                  placeholder="تێکست..."
                                                  className="w-full text-center p-1 bg-white border border-indigo-400 rounded-lg text-xs font-bold"
                                                />
                                              )}
                                            </div>
                                          </td>
                                        );
                                      })}
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>

                          {/* Save & Cancel Actions */}
                          <div className="flex flex-col sm:flex-row items-center gap-3 pt-2">
                            <button
                              onClick={handleAdminSaveTeacherEdit}
                              disabled={adminSavingLoading}
                              className="w-full sm:flex-1 py-4 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs shadow-xl flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-50"
                            >
                              {adminSavingLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
                              <span>💾 پاشکەفتن و بەڵاڤکرن بۆ هەموویان د Firebase دا (Save & Publish)</span>
                            </button>
                            <button
                              onClick={() => setAdminEditingTeacher(null)}
                              className="w-full sm:w-auto px-6 py-4 rounded-2xl bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold text-xs transition-all"
                            >
                              پاشگەزبوونەوە (Cancel)
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* TAB 2: MASTER SCHOOL TIMINGS, EXAMS, BELLS & SHIFTS (SYNC TO EVERYONE) */}
                  {adminImportTab === 'timings' && (
                    <div className="space-y-6 animate-in fade-in duration-200">
                      {/* Top Info Banner */}
                      <div className="p-4 bg-gradient-to-r from-indigo-900 via-purple-900 to-slate-900 text-white rounded-3xl shadow-md flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="p-3 bg-yellow-400 text-slate-950 rounded-2xl shadow-sm">
                            <Clock className="w-6 h-6" />
                          </div>
                          <div>
                            <h4 className="font-black text-sm text-yellow-300">وەختێت دەوامێ، جەرەس، انتیحان و شێوازێ ڕۆژان</h4>
                            <p className="text-xs text-indigo-200">هەمی گوهۆڕین د داتابەیسدا خەزن دبن و دەستبەجێ نک هەمی مامۆستا و قوتابیان بەڵاڤ دبن (Real-time Broadcast)</p>
                          </div>
                        </div>
                      </div>

                      {adminSettingsSuccessMsg && (
                        <div className="p-4 rounded-2xl bg-emerald-50 border-2 border-emerald-300 text-emerald-900 text-xs font-black flex items-center gap-2">
                          <CheckCircle className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                          <span>{adminSettingsSuccessMsg}</span>
                        </div>
                      )}

                      {/* SECTION 1: WEEKLY SHIFTS (ئێکشەمبی و دووشەمبی نیڤڕۆ، سێشەمبی، چوارشەمبی، پێنچ شەمبی سپێدە) */}
                      <div className="p-5 bg-white rounded-3xl border border-slate-200 shadow-xs space-y-4">
                        <div className="flex items-center justify-between border-b pb-3">
                          <div className="flex items-center gap-2">
                            <Calendar className="w-5 h-5 text-indigo-600" />
                            <h4 className="font-black text-sm text-slate-800">شێوازێ دەواما ڕۆژێن هەفتێ (Weekly Shifts)</h4>
                          </div>
                          <span className="text-[11px] font-bold text-slate-500 bg-slate-100 px-3 py-1 rounded-full">
                            کلیک ل هەر ڕۆژەکێ بکە بۆ گۆڕین
                          </span>
                        </div>

                        <p className="text-xs text-slate-600 font-medium">
                          📌 <strong>ڕێسایێ دیارکری:</strong> ئێکشەمبی و دووشەمبی دەواما نیڤڕۆیە، سێشەمبی و چوارشەمبی و پێنچ شەمبی دەواما سپێدێیە. دەتوانیت بە یەک کلیک شێوازەکەیان بگۆڕیت:
                        </p>

                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2.5">
                          {DAYS.map((dayName) => {
                            const currentShift = alarmSettings.dayShifts?.[dayName] || (dayName === 'ئێکشەمبی' || dayName === 'دووشەمبی' ? 'evening' : 'morning');
                            const isMorning = currentShift === 'morning';

                            return (
                              <button
                                key={dayName}
                                type="button"
                                onClick={() => {
                                  const newShifts = {
                                    ...(alarmSettings.dayShifts || DEFAULT_DAY_SHIFTS),
                                    [dayName]: (isMorning ? 'evening' : 'morning') as ShiftType
                                  };
                                  setAlarmSettings((prev) => ({ ...prev, dayShifts: newShifts }));
                                }}
                                className={`p-3.5 rounded-2xl border-2 transition-all flex flex-col items-center justify-center gap-1.5 text-center active:scale-95 ${
                                  isMorning
                                    ? 'bg-amber-50/80 border-amber-300 text-amber-900 shadow-xs'
                                    : 'bg-indigo-50/80 border-indigo-300 text-indigo-900 shadow-xs'
                                }`}
                              >
                                <span className="font-black text-xs">{dayName}</span>
                                <span className={`text-[11px] font-black px-2.5 py-0.5 rounded-full flex items-center gap-1 ${
                                  isMorning ? 'bg-amber-200 text-amber-950' : 'bg-indigo-200 text-indigo-950'
                                }`}>
                                  {isMorning ? <Sun className="w-3 h-3 text-amber-600" /> : <Moon className="w-3 h-3 text-indigo-600" />}
                                  {isMorning ? 'سپێدە (Morning)' : 'نیڤڕۆ (Evening)'}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* SECTION 2: SHIFT TIMINGS & LESSON DURATIONS */}
                      <div className="p-5 bg-white rounded-3xl border border-slate-200 shadow-xs space-y-4">
                        <div className="flex items-center gap-2 border-b pb-3">
                          <Clock className="w-5 h-5 text-indigo-600" />
                          <h4 className="font-black text-sm text-slate-800">وەختێ دەستپێکا دەوامێ و دەقێن وانان</h4>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          {/* Morning Shift */}
                          <div className="p-4 bg-amber-50/60 rounded-2xl border border-amber-200 space-y-3">
                            <div className="flex items-center justify-between">
                              <span className="font-black text-xs text-amber-950 flex items-center gap-1.5">
                                <Sun className="w-4 h-4 text-amber-600" /> دەواما سپێدێ:
                              </span>
                              <span className="text-xs font-mono font-bold text-amber-800">{alarmSettings.morningStartTime || "08:00"}</span>
                            </div>

                            <div className="space-y-1">
                              <label className="text-[11px] font-bold text-slate-600 block">وەختێ دەستپێکا دەوامی:</label>
                              <input
                                type="time"
                                value={alarmSettings.morningStartTime || "08:00"}
                                onChange={(e) => setAlarmSettings((prev) => ({ ...prev, morningStartTime: e.target.value }))}
                                className="w-full p-2.5 bg-white border border-amber-300 rounded-xl font-mono text-xs font-bold outline-none"
                              />
                            </div>

                            <div className="space-y-1">
                              <label className="text-[11px] font-bold text-slate-600 block">ماوەیا هەر وانەیەکێ (خولەک):</label>
                              <div className="grid grid-cols-4 gap-1.5">
                                {[30, 35, 40, 45].map((m) => (
                                  <button
                                    key={m}
                                    type="button"
                                    onClick={() => setAlarmSettings((prev) => ({ ...prev, morningDuration: m }))}
                                    className={`py-2 rounded-xl text-xs font-black border transition-all ${
                                      alarmSettings.morningDuration === m
                                        ? 'bg-amber-600 text-white border-amber-600 shadow-xs'
                                        : 'bg-white text-slate-700 border-slate-200 hover:bg-amber-100/50'
                                    }`}
                                  >
                                    {m} خ
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>

                          {/* Evening Shift */}
                          <div className="p-4 bg-indigo-50/60 rounded-2xl border border-indigo-200 space-y-3">
                            <div className="flex items-center justify-between">
                              <span className="font-black text-xs text-indigo-950 flex items-center gap-1.5">
                                <Moon className="w-4 h-4 text-indigo-600" /> دەواما نیڤڕۆ / ئێڤاری:
                              </span>
                              <span className="text-xs font-mono font-bold text-indigo-800">{alarmSettings.eveningStartTime || "12:30"}</span>
                            </div>

                            <div className="space-y-1">
                              <label className="text-[11px] font-bold text-slate-600 block">وەختێ دەستپێکا دەوامی:</label>
                              <input
                                type="time"
                                value={alarmSettings.eveningStartTime || "12:30"}
                                onChange={(e) => setAlarmSettings((prev) => ({ ...prev, eveningStartTime: e.target.value }))}
                                className="w-full p-2.5 bg-white border border-indigo-300 rounded-xl font-mono text-xs font-bold outline-none"
                              />
                            </div>

                            <div className="space-y-1">
                              <label className="text-[11px] font-bold text-slate-600 block">ماوەیا هەر وانەیەکێ (خولەک):</label>
                              <div className="grid grid-cols-4 gap-1.5">
                                {[30, 35, 40, 45].map((m) => (
                                  <button
                                    key={m}
                                    type="button"
                                    onClick={() => setAlarmSettings((prev) => ({ ...prev, eveningDuration: m }))}
                                    className={`py-2 rounded-xl text-xs font-black border transition-all ${
                                      alarmSettings.eveningDuration === m
                                        ? 'bg-indigo-600 text-white border-indigo-600 shadow-xs'
                                        : 'bg-white text-slate-700 border-slate-200 hover:bg-indigo-100/50'
                                    }`}
                                  >
                                    {m} خ
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Lessons Count per Day */}
                        <div className="flex flex-col sm:flex-row items-center justify-between p-3.5 bg-slate-50 rounded-2xl border border-slate-200 gap-2">
                          <span className="text-xs font-black text-slate-700">ژمارەی گشتی وانەکان لە ڕۆژێکدا:</span>
                          <div className="flex gap-2">
                            {[5, 6, 7, 8].map((c) => (
                              <button
                                key={c}
                                type="button"
                                onClick={() => setAlarmSettings((prev) => ({ ...prev, lessonCount: c }))}
                                className={`px-4 py-1.5 rounded-xl text-xs font-black border transition-all ${
                                  (alarmSettings.lessonCount || 6) === c
                                    ? 'bg-slate-900 text-white border-slate-900'
                                    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                                }`}
                              >
                                {c} دەرس
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>

                      {/* SECTION 3: EXAM SCHEDULE RULES (یاسایێن انتیحانێ) */}
                      <div className="p-5 bg-gradient-to-r from-purple-50/80 to-indigo-50/80 rounded-3xl border-2 border-purple-200 shadow-xs space-y-4">
                        <div className="flex items-center justify-between border-b border-purple-200 pb-3">
                          <div className="flex items-center gap-2">
                            <div className="p-2 bg-purple-600 text-white rounded-xl">
                              <GraduationCap className="w-5 h-5" />
                            </div>
                            <div>
                              <h4 className="font-black text-sm text-purple-950">خشتەیێ ئەزموونان / انتیحانێ (Exam Schedule Rules)</h4>
                              <p className="text-[11px] text-purple-700">دەرس 35/30 خولەک، پاش دەرسا 1 انتیحان 40 خولەک، دیڤدا دەرسا 2 دەست پێ دکەت</p>
                            </div>
                          </div>

                          <label className="relative inline-flex items-center cursor-pointer">
                            <input
                              type="checkbox"
                              checked={alarmSettings.examSettings?.enabled || false}
                              onChange={(e) => {
                                setAlarmSettings((prev) => ({
                                  ...prev,
                                  examSettings: {
                                    ...prev.examSettings,
                                    enabled: e.target.checked
                                  }
                                }));
                              }}
                              className="sr-only peer"
                            />
                            <div className="w-12 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:right-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-purple-600"></div>
                          </label>
                        </div>

                        {/* Explanatory Rule Callout */}
                        <div className="p-4 bg-white/90 rounded-2xl border border-purple-200 text-xs text-purple-950 leading-relaxed font-medium">
                          📌 <strong>یاسایێ ڕەسمیێ انتیحانێ:</strong>
                          <ul className="list-disc list-inside mt-1.5 space-y-1 text-slate-700">
                            <li><strong>دەواما سپێدێ:</strong> هەموو وانە 35 خولەکن. دەرسا 1 خلاس دەبێت، ڕاستەوخۆ دیڤدا انتیحان (40 خولەک) ئەنجام دەدرێت، پاشان دەرسا 2 دەست پێ دەکات.</li>
                            <li><strong>دەواما نیڤڕۆ:</strong> هەموو وانە 30 خولەکن. دەرسا 1 خلاس دەبێت، ڕاستەوخۆ دیڤدا انتیحان (40 خولەک) ئەنجام دەدرێت، پاشان دەرسا 2 دەست پێ دەکات.</li>
                          </ul>
                        </div>

                        {/* Exam Custom Controls */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                          <div>
                            <label className="text-[11px] font-black text-purple-900 block mb-1">وانا سپێدێ (خولەک):</label>
                            <input
                              type="number"
                              value={alarmSettings.examSettings?.morningLessonDuration || 35}
                              onChange={(e) => {
                                const val = parseInt(e.target.value) || 35;
                                setAlarmSettings((prev) => ({
                                  ...prev,
                                  examSettings: { ...prev.examSettings, morningLessonDuration: val }
                                }));
                              }}
                              className="w-full p-2.5 bg-white border border-purple-300 rounded-xl font-bold text-xs outline-none"
                            />
                          </div>

                          <div>
                            <label className="text-[11px] font-black text-purple-900 block mb-1">وانا نیڤڕۆ (خولەک):</label>
                            <input
                              type="number"
                              value={alarmSettings.examSettings?.eveningLessonDuration || 30}
                              onChange={(e) => {
                                const val = parseInt(e.target.value) || 30;
                                setAlarmSettings((prev) => ({
                                  ...prev,
                                  examSettings: { ...prev.examSettings, eveningLessonDuration: val }
                                }));
                              }}
                              className="w-full p-2.5 bg-white border border-purple-300 rounded-xl font-bold text-xs outline-none"
                            />
                          </div>

                          <div>
                            <label className="text-[11px] font-black text-purple-900 block mb-1">ماوەیا انتیحانێ (خولەک):</label>
                            <input
                              type="number"
                              value={alarmSettings.examSettings?.examDuration || 40}
                              onChange={(e) => {
                                const val = parseInt(e.target.value) || 40;
                                setAlarmSettings((prev) => ({
                                  ...prev,
                                  examSettings: { ...prev.examSettings, examDuration: val }
                                }));
                              }}
                              className="w-full p-2.5 bg-white border border-purple-300 rounded-xl font-bold text-xs outline-none"
                            />
                          </div>

                          <div>
                            <label className="text-[11px] font-black text-purple-900 block mb-1">فرسەت پشتی انتیحانێ:</label>
                            <input
                              type="number"
                              value={alarmSettings.examSettings?.breakAfterExam || 10}
                              onChange={(e) => {
                                const val = parseInt(e.target.value) || 10;
                                setAlarmSettings((prev) => ({
                                  ...prev,
                                  examSettings: { ...prev.examSettings, breakAfterExam: val }
                                }));
                              }}
                              className="w-full p-2.5 bg-white border border-purple-300 rounded-xl font-bold text-xs outline-none"
                            />
                          </div>
                        </div>
                      </div>

                      {/* SECTION 4: BREAKS & BELLS */}
                      <div className="p-5 bg-white rounded-3xl border border-slate-200 shadow-xs space-y-4">
                        <div className="flex items-center gap-2 border-b pb-3">
                          <Bell className="w-5 h-5 text-indigo-600" />
                          <h4 className="font-black text-sm text-slate-800">فرسەت، جەرەس و بێهنڤەدان</h4>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          <div>
                            <label className="text-[11px] font-bold text-slate-600 block mb-1">جەرەسێ ئاسایی بەینا وانان:</label>
                            <select
                              value={alarmSettings.defaultBreakDuration || 5}
                              onChange={(e) => setAlarmSettings((prev) => ({ ...prev, defaultBreakDuration: parseInt(e.target.value) }))}
                              className="w-full p-2.5 bg-white border border-slate-300 rounded-xl font-bold text-xs outline-none"
                            >
                              <option value={3}>3 خولەک</option>
                              <option value={5}>5 خولەک (ئاسایی)</option>
                              <option value={7}>7 خولەک</option>
                              <option value={10}>10 خولەک</option>
                            </select>
                          </div>

                          <div>
                            <label className="text-[11px] font-bold text-slate-600 block mb-1">فرسەتا مەزن:</label>
                            <select
                              value={alarmSettings.longBreakDuration || 10}
                              onChange={(e) => setAlarmSettings((prev) => ({ ...prev, longBreakDuration: parseInt(e.target.value) }))}
                              className="w-full p-2.5 bg-white border border-slate-300 rounded-xl font-bold text-xs outline-none"
                            >
                              <option value={10}>10 خولەک</option>
                              <option value={15}>15 خولەک</option>
                              <option value={20}>20 خولەک</option>
                            </select>
                          </div>

                          <div>
                            <label className="text-[11px] font-bold text-slate-600 block mb-1">فرسەتا مەزن پشتی چ وانەیەکێ:</label>
                            <select
                              value={alarmSettings.longBreakLesson || 3}
                              onChange={(e) => setAlarmSettings((prev) => ({ ...prev, longBreakLesson: parseInt(e.target.value) }))}
                              className="w-full p-2.5 bg-white border border-slate-300 rounded-xl font-bold text-xs outline-none"
                            >
                              <option value={2}>پشتی وانا 2</option>
                              <option value={3}>پشتی وانا 3</option>
                              <option value={4}>پشتی وانا 4</option>
                            </select>
                          </div>
                        </div>
                      </div>

                      {/* SECTION 5: ALL KURDISH LETTERS TOGGLE */}
                      <div className="p-5 bg-white rounded-3xl border border-slate-200 shadow-xs space-y-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="p-2.5 bg-indigo-600 text-white rounded-2xl shadow-sm">
                              <Layers className="w-5 h-5 text-yellow-300" />
                            </div>
                            <div>
                              <h4 className="font-black text-xs text-indigo-950">هەموو پیتێن ئەلفوبێیا کوردی بۆ هەمی قۆناغان (10، 11، 12)</h4>
                              <p className="text-[11px] text-slate-500">بە دیفۆڵت تا هۆبەی (ز) بەردەستە. بە چالاککردن هەموو 34 پیتەکان بەردەست دەبن.</p>
                            </div>
                          </div>

                          <label className="relative inline-flex items-center cursor-pointer">
                            <input
                              type="checkbox"
                              checked={alarmSettings.allKurdishLettersEnabled || false}
                              onChange={(e) => {
                                setAlarmSettings((prev) => ({ ...prev, allKurdishLettersEnabled: e.target.checked }));
                              }}
                              className="sr-only peer"
                            />
                            <div className="w-12 h-6 bg-slate-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:right-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
                          </label>
                        </div>
                      </div>

                      {/* MASTER SAVE & BROADCAST BUTTON */}
                      <div className="pt-2">
                        <button
                          type="button"
                          onClick={() => handleAdminSaveMasterSettings()}
                          disabled={adminSavingSettings}
                          className="w-full py-4 rounded-2xl bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] text-white font-black text-sm shadow-xl flex items-center justify-center gap-3 transition-all disabled:opacity-50"
                        >
                          {adminSavingSettings ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5 text-yellow-300" />}
                          <span>💾 پاشکەفتن و بەڵاڤکرن بۆ هەموویان د Firebase دا (Save & Broadcast)</span>
                        </button>
                      </div>
                    </div>
                  )}

                  {/* TAB 2: TEACHER CHANGE REQUESTS (داخوازیێن دەستکاریێ) */}
                  {adminImportTab === 'requests' && (
                    <div className="space-y-5 animate-in fade-in duration-200">
                      <div className="p-4 bg-gradient-to-r from-amber-900 via-indigo-950 to-slate-900 text-white rounded-3xl shadow-md flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="p-3 bg-amber-400 text-slate-950 rounded-2xl shadow-sm">
                            <Layers className="w-6 h-6" />
                          </div>
                          <div>
                            <h4 className="font-black text-sm text-yellow-300">داخوازیێن دەستکاریکردنی جەتوەلا مامۆستایان</h4>
                            <p className="text-xs text-amber-200">هەر دەمێ مامۆستایەک دەستکاریێ بکەت، لێرەدا دەردەکەوێت و پاش پەسەندکردن ل هەموو جەتوەلان نوێ دەبێتەوە</p>
                          </div>
                        </div>
                        <span className="text-xs font-black bg-amber-400/20 text-yellow-300 px-3.5 py-1.5 rounded-full border border-yellow-400/30">
                          {changeRequests.filter(r => r.status === 'pending').length} داخوازییا نوێ
                        </span>
                      </div>

                      {/* Filter Bar */}
                      <div className="flex items-center gap-2 p-1.5 bg-white rounded-2xl border border-slate-200 shadow-2xs">
                        {[
                          { id: 'all', label: 'هەموو داخوازییەکان', count: changeRequests.length },
                          { id: 'pending', label: 'چاوەڕوانکراو (نوێ)', count: changeRequests.filter(r => r.status === 'pending').length },
                          { id: 'approved', label: 'قبوولکراوەکان', count: changeRequests.filter(r => r.status === 'approved').length },
                          { id: 'rejected', label: 'ڕەتکراوەکان', count: changeRequests.filter(r => r.status === 'rejected').length },
                        ].map((tab) => (
                          <button
                            key={tab.id}
                            type="button"
                            onClick={() => setRequestFilterStatus(tab.id as any)}
                            className={`flex-1 py-2 rounded-xl text-xs font-black transition-all flex items-center justify-center gap-1.5 ${
                              requestFilterStatus === tab.id
                                ? 'bg-indigo-600 text-white shadow-xs'
                                : 'text-slate-600 hover:bg-slate-100'
                            }`}
                          >
                            <span>{tab.label}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                              requestFilterStatus === tab.id ? 'bg-white/20 text-white' : 'bg-slate-200 text-slate-700'
                            }`}>
                              {tab.count}
                            </span>
                          </button>
                        ))}
                      </div>

                      {/* Requests List */}
                      {(() => {
                        const filtered = changeRequests.filter((r) => {
                          if (requestFilterStatus === 'all') return true;
                          return r.status === requestFilterStatus;
                        });

                        if (filtered.length === 0) {
                          return (
                            <div className="p-10 text-center bg-white rounded-3xl border border-dashed border-slate-300 space-y-2">
                              <CheckCircle2 className="w-10 h-10 text-slate-400 mx-auto" />
                              <p className="font-bold text-sm text-slate-700">هیچ داخوازییەک لەم بەشەدا نییە!</p>
                              <p className="text-xs text-slate-500">کاتی مامۆستایان خشتەی خۆیان دەستکاری دەکەن، ڕاستەوخۆ داخوازییەکان لێرەدا تۆمار دەبن.</p>
                            </div>
                          );
                        }

                        return (
                          <div className="space-y-4">
                            {filtered.map((req) => {
                              const isLoading = requestActionLoadingId === req.id;
                              return (
                                <div
                                  key={req.id}
                                  className={`p-5 rounded-3xl border transition-all ${
                                    req.status === 'pending'
                                      ? 'bg-amber-50/50 border-amber-300 shadow-md ring-2 ring-amber-400/20'
                                      : req.status === 'approved'
                                      ? 'bg-emerald-50/40 border-emerald-200'
                                      : 'bg-rose-50/30 border-rose-200'
                                  }`}
                                >
                                  <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-b pb-3">
                                    <div className="flex items-center gap-3">
                                      <div className={`p-2.5 rounded-2xl ${
                                        req.status === 'pending' ? 'bg-amber-500 text-white' : req.status === 'approved' ? 'bg-emerald-600 text-white' : 'bg-rose-500 text-white'
                                      }`}>
                                        <User className="w-5 h-5" />
                                      </div>
                                      <div>
                                        <div className="flex items-center gap-2">
                                          <h4 className="font-black text-sm text-slate-900">{req.teacherName}</h4>
                                          <span className="text-[11px] font-bold px-2 py-0.5 rounded-md bg-indigo-100 text-indigo-800">
                                            {req.subject || 'کیمیا'}
                                          </span>
                                        </div>
                                        <span className="text-[11px] text-slate-500 font-medium">
                                          بەروار: {req.createdAt ? new Date(req.createdAt).toLocaleString('ku') : 'نوێ'}
                                        </span>
                                      </div>
                                    </div>

                                    {/* Status Badge */}
                                    <div>
                                      {req.status === 'pending' && (
                                        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-100 border border-amber-300 text-amber-900 text-xs font-black animate-pulse">
                                          <Clock className="w-3.5 h-3.5 text-amber-600" />
                                          چاوەڕوانی پەسەندکردنە
                                        </span>
                                      )}
                                      {req.status === 'approved' && (
                                        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-100 border border-emerald-300 text-emerald-900 text-xs font-black">
                                          <CheckCircle className="w-3.5 h-3.5 text-emerald-600" />
                                          پەسەندکرا و بەڵاڤ بوو
                                        </span>
                                      )}
                                      {req.status === 'rejected' && (
                                        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-rose-100 border border-rose-300 text-rose-900 text-xs font-black">
                                          <X className="w-3.5 h-3.5 text-rose-600" />
                                          ڕەتکرایەوە
                                        </span>
                                      )}
                                    </div>
                                  </div>

                                  {/* Changes details */}
                                  <div className="py-3 text-xs text-slate-700 font-medium">
                                    <div className="p-3 bg-white/80 rounded-2xl border border-slate-200">
                                      <p className="font-bold text-slate-800 mb-1">کورتەی گۆڕانکارییەکان:</p>
                                      <p className="text-slate-600 font-mono text-[11px] leading-relaxed">
                                        {req.changesSummary || "دەستکاریکردنی پۆلەکان لە خشتەی حەفتانەدا"}
                                      </p>
                                    </div>
                                  </div>

                                  {/* Action Buttons for Pending */}
                                  {req.status === 'pending' && (
                                    <div className="flex flex-col sm:flex-row items-center gap-2 pt-2">
                                      <button
                                        type="button"
                                        onClick={() => handleAdminApproveChangeRequest(req)}
                                        disabled={isLoading}
                                        className="w-full sm:flex-1 py-3 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs shadow-md flex items-center justify-center gap-2 active:scale-95 transition-all disabled:opacity-50"
                                      >
                                        {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4 text-yellow-300" />}
                                        <span>قبوولکرن و بەڵاڤکرن بۆ هەمووان (Approve & Broadcast)</span>
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          const reason = prompt("هۆکاری ڕەتکردنەوە (ئارەزوومەندانە):") || '';
                                          handleAdminRejectChangeRequest(req, reason);
                                        }}
                                        disabled={isLoading}
                                        className="w-full sm:w-auto py-3 px-4 rounded-xl bg-rose-100 hover:bg-rose-200 text-rose-800 font-black text-xs border border-rose-200 active:scale-95 transition-all disabled:opacity-50"
                                      >
                                        ڕەتکرن (Reject)
                                      </button>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}
                    </div>
                  )}

                  {/* TAB 4: SECTION LETTERS CONFIGURATION (دیاریکردن و تەحدیدکرنی پیتێن هۆبان) */}
                  {adminImportTab === 'sections' && (
                    <div className="space-y-6 animate-in fade-in duration-200">
                      {/* Top Info Banner */}
                      <div className="p-4 bg-gradient-to-r from-purple-900 via-indigo-900 to-slate-900 text-white rounded-3xl shadow-md flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="p-3 bg-purple-400 text-slate-950 rounded-2xl shadow-sm">
                            <Building2 className="w-6 h-6" />
                          </div>
                          <div>
                            <h4 className="font-black text-sm text-yellow-300">دیاریکردن و تەحدیدکرنی پیتێن هۆبان (Section Letters)</h4>
                            <p className="text-xs text-purple-200">ئەدمین دەتوانێت بە دڵی خۆ ژمارەی هۆبەکان (٤، ٧، یان تا ٣٤ پیت) دیاری بکات و بە سەرکەوتوویی لە داتابەیسدا پاشکەوتی بکات</p>
                          </div>
                        </div>
                      </div>

                      {adminSettingsSuccessMsg && (
                        <div className="p-4 rounded-2xl bg-emerald-50 border-2 border-emerald-300 text-emerald-900 text-xs font-black flex items-center gap-2">
                          <CheckCircle className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                          <span>{adminSettingsSuccessMsg}</span>
                        </div>
                      )}

                      {/* SECTION 1: QUICK PRESETS */}
                      <div className="p-5 bg-white rounded-3xl border border-slate-200 shadow-xs space-y-3">
                        <h4 className="font-black text-xs text-slate-700 flex items-center gap-2">
                          <span>⚡ هەڵبژاردنی خێرای ژمارەی هۆبەکان:</span>
                        </h4>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                          <button
                            type="button"
                            onClick={() => {
                              const chosen = ALL_KURDISH_SECTIONS.slice(0, 4);
                              setAlarmSettings(prev => ({ ...prev, customSections: chosen, customSectionsCount: 4 }));
                            }}
                            className={`p-3 rounded-2xl border-2 text-xs font-black transition-all ${
                              (alarmSettings.customSections?.length === 4)
                                ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                                : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
                            }`}
                          >
                            <span className="block text-sm font-black">٤ هۆبە</span>
                            <span className="text-[10px] opacity-80 block mt-0.5">ئـ، ب، ج، د</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setAlarmSettings(prev => ({ ...prev, customSections: STANDARD_SECTIONS, customSectionsCount: 7 }));
                            }}
                            className={`p-3 rounded-2xl border-2 text-xs font-black transition-all ${
                              (!alarmSettings.customSections || alarmSettings.customSections?.length === 7)
                                ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                                : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
                            }`}
                          >
                            <span className="block text-sm font-black">٧ هۆبە (ستاندارد)</span>
                            <span className="text-[10px] opacity-80 block mt-0.5">ئـ تا ز</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              const chosen = ALL_KURDISH_SECTIONS.slice(0, 12);
                              setAlarmSettings(prev => ({ ...prev, customSections: chosen, customSectionsCount: 12 }));
                            }}
                            className={`p-3 rounded-2xl border-2 text-xs font-black transition-all ${
                              (alarmSettings.customSections?.length === 12)
                                ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                                : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
                            }`}
                          >
                            <span className="block text-sm font-black">١٢ هۆبە (فراوان)</span>
                            <span className="text-[10px] opacity-80 block mt-0.5">ئـ تا ل</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              setAlarmSettings(prev => ({ ...prev, customSections: ALL_KURDISH_SECTIONS, customSectionsCount: 34 }));
                            }}
                            className={`p-3 rounded-2xl border-2 text-xs font-black transition-all ${
                              (alarmSettings.customSections?.length === 34)
                                ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                                : 'bg-slate-50 hover:bg-slate-100 text-slate-700 border-slate-200'
                            }`}
                          >
                            <span className="block text-sm font-black">هەموو ئەلفوبێ (٣٤ پیت)</span>
                            <span className="text-[10px] opacity-80 block mt-0.5">تەواوی پیتە کوردییەکان</span>
                          </button>
                        </div>
                      </div>

                      {/* SECTION 2: SLIDER FOR NUMBER OF SECTIONS */}
                      {(() => {
                        const activeList = getActiveSections(alarmSettings);
                        const count = activeList.length;
                        return (
                          <div className="p-5 bg-white rounded-3xl border border-slate-200 shadow-xs space-y-4">
                            <div className="flex items-center justify-between border-b pb-3">
                              <span className="font-black text-xs text-slate-700">ژمارەی دیاریکراوی پیتەکانی هۆبە:</span>
                              <span className="text-base font-black px-3.5 py-1 rounded-xl bg-purple-100 text-purple-900 border border-purple-200">
                                {count} هۆبە
                              </span>
                            </div>

                            <div className="space-y-2">
                              <input
                                type="range"
                                min={1}
                                max={34}
                                value={count}
                                onChange={(e) => {
                                  const val = Number(e.target.value);
                                  const sliced = ALL_KURDISH_SECTIONS.slice(0, val);
                                  setAlarmSettings(prev => ({ ...prev, customSections: sliced, customSectionsCount: val }));
                                }}
                                className="w-full accent-purple-600 h-2 bg-slate-200 rounded-lg cursor-pointer"
                              />
                              <div className="flex justify-between text-[10px] text-slate-400 font-bold px-1">
                                <span>١ هۆبە</span>
                                <span>٧ (ستاندارد)</span>
                                <span>١٤ هۆبە</span>
                                <span>٢١ هۆبە</span>
                                <span>٣٤ (هەموو ئەلفوبێ)</span>
                              </div>
                            </div>
                          </div>
                        );
                      })()}

                      {/* SECTION 3: INTERACTIVE 34-LETTER KURDISH ALPHABET GRID */}
                      <div className="p-5 bg-white rounded-3xl border border-slate-200 shadow-xs space-y-4">
                        <div className="flex items-center justify-between border-b pb-3">
                          <h4 className="font-black text-xs text-slate-800">
                            هەڵبژاردنی تاک بە تاکی پیتە کوردییەکان (کلیک ل هەر پیتەکێ بکە بۆ چالاککردن یان ناچالاککردن):
                          </h4>
                          <span className="text-[11px] text-slate-500 font-bold">
                            {getActiveSections(alarmSettings).length} لە ٣٤ پیت چالاکن
                          </span>
                        </div>

                        <div className="grid grid-cols-6 sm:grid-cols-9 md:grid-cols-12 gap-2">
                          {ALL_KURDISH_SECTIONS.map((letter, idx) => {
                            const activeList = getActiveSections(alarmSettings);
                            const isActive = activeList.includes(letter);
                            return (
                              <button
                                key={letter}
                                type="button"
                                onClick={() => {
                                  let updated: string[];
                                  if (isActive) {
                                    if (activeList.length <= 1) {
                                      alert("پێویستە بەلایەنی کەم یەک هۆبە هەبێت!");
                                      return;
                                    }
                                    updated = activeList.filter(l => l !== letter);
                                  } else {
                                    updated = [...activeList, letter];
                                  }
                                  setAlarmSettings(prev => ({ ...prev, customSections: updated, customSectionsCount: updated.length }));
                                }}
                                className={`p-2.5 rounded-2xl border-2 transition-all flex flex-col items-center justify-center relative active:scale-95 ${
                                  isActive
                                    ? 'bg-purple-600 text-white border-purple-600 shadow-sm'
                                    : 'bg-slate-50 hover:bg-slate-100 text-slate-500 border-slate-200'
                                }`}
                              >
                                <span className="text-base font-black">{letter}</span>
                                <span className="text-[9px] font-bold opacity-70 mt-0.5">{idx + 1}</span>
                                {isActive && (
                                  <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-yellow-300" />
                                )}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* SECTION 4: ADD CUSTOM SECTION LETTER OR CODE */}
                      <div className="p-5 bg-white rounded-3xl border border-slate-200 shadow-xs space-y-3">
                        <h4 className="font-black text-xs text-slate-800">زیادکردنی ناوی هۆبەی تایبەت (Custom Section Name):</h4>
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={adminCustomSectionInput}
                            onChange={(e) => setAdminCustomSectionInput(e.target.value)}
                            placeholder="پیت یان ناوی هۆبە بنووسە (بۆ نموونە: أ، A، ١، زانستی)..."
                            className="flex-1 p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold outline-none focus:border-purple-500"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const val = adminCustomSectionInput.trim();
                              if (!val) return;
                              const currentList = getActiveSections(alarmSettings);
                              if (currentList.includes(val)) {
                                alert("ئەم هۆبەیە پێشتر هەیە!");
                                return;
                              }
                              const updated = [...currentList, val];
                              setAlarmSettings(prev => ({ ...prev, customSections: updated, customSectionsCount: updated.length }));
                              setAdminCustomSectionInput('');
                            }}
                            className="px-5 py-3 rounded-xl bg-purple-600 hover:bg-purple-700 text-white text-xs font-black shadow-xs active:scale-95 transition-all"
                          >
                            + زیادکردن
                          </button>
                        </div>
                      </div>

                      {/* SECTION 5: LIVE PREVIEW */}
                      <div className="p-5 bg-purple-50/60 rounded-3xl border border-purple-200 space-y-3">
                        <div className="flex items-center justify-between border-b border-purple-200/60 pb-2">
                          <span className="font-black text-xs text-purple-950">پێشبینینی ڕاستەوخۆ (Live Preview):</span>
                          <span className="text-[11px] font-bold text-purple-700">
                            {getActiveSections(alarmSettings).length} هۆبە ئامادەن
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {getActiveSections(alarmSettings).map((sec) => (
                            <span
                              key={sec}
                              className="px-3 py-1 rounded-xl bg-white border border-purple-300 text-purple-900 text-xs font-black shadow-2xs"
                            >
                              هۆبەیا ({sec})
                            </span>
                          ))}
                        </div>
                        <p className="text-[11px] text-slate-500 font-medium pt-1">
                          📌 نموونەی پۆلەکان: {getActiveSections(alarmSettings).slice(0, 4).map(s => `پۆلا ١٠ - ${s}`).join('، ')} ...
                        </p>
                      </div>

                      {/* MASTER SAVE & BROADCAST BUTTON */}
                      <div className="pt-2">
                        <button
                          type="button"
                          onClick={() => {
                            const activeList = getActiveSections(alarmSettings);
                            handleAdminSaveMasterSettings({
                              ...alarmSettings,
                              customSections: activeList,
                              customSectionsCount: activeList.length
                            });
                          }}
                          disabled={adminSavingSettings}
                          className="w-full py-4 rounded-2xl bg-purple-600 hover:bg-purple-700 active:scale-[0.98] text-white font-black text-sm shadow-xl flex items-center justify-center gap-3 transition-all disabled:opacity-50"
                        >
                          {adminSavingSettings ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5 text-yellow-300" />}
                          <span>💾 پاشکەفتن و بەڵاڤکرنی پیتێن هۆبان بۆ هەمووان د Firebase دا (Save & Broadcast)</span>
                        </button>
                      </div>
                    </div>
                  )}

                  {adminImportTab === 'code' && (
                    <div className="space-y-3">
                      <textarea
                        value={adminCodeInput}
                        onChange={(e) => setAdminCodeInput(e.target.value)}
                        placeholder="کۆدی JSON بۆ لێرە بپێسەت بکە..."
                        className="w-full text-xs font-mono p-3 bg-white border border-slate-300 rounded-2xl h-32 outline-none"
                      />
                      <button
                        onClick={() => handleImportCodeOrFile()}
                        disabled={adminBatchLoading || !adminCodeInput.trim()}
                        className="w-full py-3 rounded-2xl bg-indigo-600 hover:bg-indigo-700 text-white font-black text-xs shadow-md"
                      >
                        پێداچوونەوە و شیکارکرنی کۆدەکە
                      </button>
                    </div>
                  )}

                  {adminImportTab === 'file' && (
                    <label className="border-2 border-dashed border-slate-300 bg-white hover:bg-indigo-50/50 p-8 rounded-2xl flex flex-col items-center justify-center cursor-pointer text-center">
                      <Upload className="w-8 h-8 text-indigo-600 mb-2" />
                      <span className="font-bold text-xs text-slate-700">فایلی PDF یان وێنەی جەتوەلەکان هەڵبژێرە</span>
                      <span className="text-[10px] text-slate-400 mt-1">PDF, PNG, JPG</span>
                      <input
                        type="file"
                        accept="image/*,.pdf,.json"
                        className="hidden"
                        onChange={(e) => e.target.files && handleImportCodeOrFile(e.target.files[0])}
                      />
                    </label>
                  )}
                </div>

                {adminSuccessMsg && (
                  <div className="p-4 rounded-2xl bg-emerald-50 border border-emerald-300 text-emerald-900 text-xs font-black flex items-center justify-between">
                    <span>{adminSuccessMsg}</span>
                  </div>
                )}

                {/* Batch Review Table */}
                {adminBatchPreview.length > 0 && (
                  <div className="space-y-3 border-t pt-4">
                    <h4 className="font-black text-slate-800 text-sm">پێداچوونەوەی جەتوەلەکانی ئامادەکراو:</h4>
                    <div className="border rounded-2xl overflow-x-auto max-h-60">
                      <table className="w-full text-xs text-center border-collapse">
                        <thead>
                          <tr className="bg-slate-100 font-black border-b">
                            <th className="p-2 border-l">ناڤی مامۆستا</th>
                            <th className="p-2 border-l">بابەت</th>
                            <th className="p-2 border-l">دۆخ</th>
                          </tr>
                        </thead>
                        <tbody>
                          {adminBatchPreview.map((tb, idx) => (
                            <tr key={idx} className="border-b">
                              <td className="p-2 font-bold border-l">{tb.teacherName}</td>
                              <td className="p-2 font-bold border-l">{tb.subject}</td>
                              <td className="p-2 text-emerald-600 font-bold border-l">ئامادەیە بۆ بەڵاڤکرن ✓</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <button
                      onClick={handlePublishAdminBatch}
                      disabled={adminBatchLoading}
                      className="w-full py-4 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-black text-xs shadow-xl flex items-center justify-center gap-2 active:scale-95 transition-all"
                    >
                      {adminBatchLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <Sparkles className="w-5 h-5" />}
                      <span>🚀 بەڵاڤکرنا هەموو جەتوەلەکان بۆ داتابێسا Firebase</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Teacher Live Status & Location Modal */}
      {showTeacherStatusModal && selectedLookupTeacher && (() => {
        const summary = getTeacherTodaySummary(selectedLookupTeacher);
        const activeSlotNow = currentLiveSlot.slot;
        const daySched = selectedLookupTeacher.schedule[activeDay];
        const todaySlots = daySched?.slots || [];
        
        // Find current live slot
        const currentSlotIndex = activeSlotNow ? todaySlots.findIndex(s => s.startTime === activeSlotNow.startTime) : -1;
        const currentSlotForTeacher = currentSlotIndex >= 0 ? todaySlots[currentSlotIndex] : null;
        const rawClassNow = currentSlotForTeacher ? currentSlotForTeacher.className : 'بێ وانە';
        const parsedNow = parseClassAndSection(rawClassNow);
        const isTeachingNow = currentLiveSlot.status === 'active' && rawClassNow !== 'بێ وانە' && rawClassNow !== 'فەراغ';

        return (
          <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/75 backdrop-blur-md p-4 animate-in fade-in duration-200">
            <div className="bg-white rounded-[2.5rem] max-w-lg w-full shadow-2xl overflow-hidden flex flex-col max-h-[92vh] border border-slate-100">
              {/* Modal Top Banner Header */}
              <div className="p-6 bg-gradient-to-r from-slate-900 via-indigo-950 to-purple-950 text-white flex justify-between items-start relative overflow-hidden">
                <div className="absolute -right-10 -bottom-10 opacity-10">
                  <GraduationCap className="w-48 h-48" />
                </div>
                <div className="relative z-10 flex items-center gap-4">
                  <div className="w-16 h-16 rounded-2xl bg-indigo-600/50 border-2 border-indigo-400/50 backdrop-blur-md flex items-center justify-center font-black text-2xl text-yellow-300 shadow-lg">
                    {selectedLookupTeacher.teacherName.slice(0, 2)}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-black text-xl text-white">{selectedLookupTeacher.teacherName}</h3>
                      <span className="text-[10px] font-extrabold bg-indigo-500/30 text-indigo-200 border border-indigo-400/30 px-2.5 py-0.5 rounded-full">
                        {selectedLookupTeacher.subject || 'گشتی'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-300 font-medium mt-1">
                      📅 ڕۆژا {activeDay} | گشتی {summary.countToday} وانە دگریت
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setShowTeacherStatusModal(false)}
                  className="relative z-10 p-2 hover:bg-white/10 rounded-full text-slate-300 transition-all"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              {/* Modal Body */}
              <div className="p-6 space-y-5 overflow-y-auto no-scrollbar">
                {/* Current Live Teaching Location Card (جهێ نوکە وانە لێ) */}
                <div className={`p-5 rounded-3xl border-2 transition-all space-y-3.5 shadow-sm ${
                  isTeachingNow 
                    ? 'bg-gradient-to-br from-emerald-500/10 via-emerald-500/5 to-teal-500/10 border-emerald-500/40 text-emerald-950'
                    : 'bg-slate-50 border-slate-200 text-slate-800'
                }`}>
                  <div className="flex items-center justify-between border-b pb-3 border-slate-200/60">
                    <span className="text-xs font-black uppercase tracking-widest flex items-center gap-2">
                      {isTeachingNow ? (
                        <span className="flex items-center gap-1.5 text-emerald-600 bg-emerald-100 px-3 py-1 rounded-full text-[11px]">
                          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-ping" />
                          🔴 نوکە د پۆلێ دایە (Currently Teaching)
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-slate-600 bg-slate-200/80 px-3 py-1 rounded-full text-[11px]">
                          ⚪ بەتاڵە / فەراغ یان دەرڤەی دەوامی
                        </span>
                      )}
                    </span>
                    <span className="text-xs font-extrabold text-slate-500">جهێ نوکە وانە لێ</span>
                  </div>

                  {/* Big Class, Grade & Section Grid */}
                  <div className="grid grid-cols-2 gap-3 text-center">
                    {/* Grade / Class Box */}
                    <div className="p-3.5 rounded-2xl bg-white border border-slate-200/80 shadow-xs space-y-1">
                      <span className="text-[11px] font-bold text-slate-400 block">چ پۆل (Grade)</span>
                      <span className="text-lg font-black text-indigo-900 block">
                        {parsedNow.grade}
                      </span>
                    </div>

                    {/* Section / Huba Box */}
                    <div className="p-3.5 rounded-2xl bg-white border border-slate-200/80 shadow-xs space-y-1">
                      <span className="text-[11px] font-bold text-slate-400 block">چ هۆبە (Section)</span>
                      <span className="text-lg font-black text-purple-900 block">
                        {parsedNow.section}
                      </span>
                    </div>
                  </div>

                  {/* Subject Info */}
                  <div className="flex items-center justify-between p-3 rounded-2xl bg-white/80 border border-slate-200/60 text-xs font-bold">
                    <span className="text-slate-500">چ بابەت دەبێت:</span>
                    <span className="text-indigo-700 font-black">{selectedLookupTeacher.subject || 'کیمیا'}</span>
                  </div>
                </div>

                {/* Full Today Breakdown */}
                <div className="space-y-3">
                  <h4 className="font-black text-sm text-slate-800 flex items-center justify-between">
                    <span>خشتەیێ وانێن ئەڤڕۆ ({activeDay}):</span>
                    <span className="text-xs font-extrabold text-indigo-600 bg-indigo-50 px-2.5 py-1 rounded-full">
                      {summary.countToday} وانە
                    </span>
                  </h4>

                  <div className="space-y-2">
                    {todaySlots.map((slot, sIdx) => {
                      const parsed = parseClassAndSection(slot.className);
                      const isCurrent = activeSlotNow && activeSlotNow.startTime === slot.startTime;
                      return (
                        <div
                          key={slot.id || sIdx}
                          className={`p-3.5 rounded-2xl border transition-all flex items-center justify-between ${
                            isCurrent
                              ? 'bg-indigo-600 text-white border-indigo-600 shadow-md scale-[1.01]'
                              : slot.className === 'بێ وانە'
                              ? 'bg-slate-50 border-slate-200 text-slate-400'
                              : 'bg-white border-slate-200 text-slate-800 hover:border-indigo-300'
                          }`}
                        >
                          <div className="flex items-center gap-3">
                            <div className={`w-8 h-8 rounded-xl font-black text-xs flex items-center justify-center ${
                              isCurrent ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-700'
                            }`}>
                              {sIdx + 1}
                            </div>
                            <div>
                              <div className="font-black text-sm flex items-center gap-2">
                                <span>{parsed.fullLabel}</span>
                                {isCurrent && (
                                  <span className="text-[9px] bg-yellow-400 text-slate-950 px-2 py-0.5 rounded-full font-black">
                                    نوکە ⚡
                                  </span>
                                )}
                              </div>
                              <p className={`text-[11px] font-medium ${isCurrent ? 'text-indigo-100' : 'text-slate-400'}`}>
                                {slot.startTime} — {slot.endTime}
                              </p>
                            </div>
                          </div>

                          <span className={`text-xs font-bold px-2.5 py-1 rounded-xl ${
                            slot.className === 'بێ وانە'
                              ? 'bg-slate-200/50 text-slate-400'
                              : isCurrent
                              ? 'bg-white/20 text-white'
                              : 'bg-indigo-50 text-indigo-700'
                          }`}>
                            {slot.className === 'بێ وانە' ? 'فەراغ' : selectedLookupTeacher.subject || 'کیمیا'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Action Button: Set as main view timetable */}
                <button
                  onClick={() => {
                    selectTeacherProfile(selectedLookupTeacher);
                    setShowTeacherStatusModal(false);
                  }}
                  className="w-full py-4 rounded-2xl bg-indigo-600 hover:bg-indigo-700 text-white font-black text-xs shadow-xl flex items-center justify-center gap-2 active:scale-95 transition-all"
                >
                  <CheckCircle2 className="w-5 h-5 text-yellow-300" />
                  <span>نیشاندانا ڤی جەتوەلی وەک جەتوەلا سەرەکی د بەرنامەی دا</span>
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Main Header - Device Adapted (Mobile, Tablet, Desktop) */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-sm no-print w-full">
        <div className="max-w-7xl mx-auto px-3 sm:px-4 py-2.5 sm:py-3 flex flex-col gap-2">
          
          {/* Top Primary Bar */}
          <div className="flex items-center justify-between gap-2 w-full">
            
            {/* Title & Badge */}
            <div className="flex items-center gap-2 sm:gap-3 min-w-0">
              <div className="p-2 sm:p-2.5 rounded-2xl shadow-md shrink-0" style={{ backgroundColor: 'var(--primary-color)' }}>
                <LayoutGrid className="text-white w-4 h-4 sm:w-5 sm:h-5" />
              </div>
              <div className="min-w-0">
                <h1 className="text-sm sm:text-base md:text-lg font-black text-slate-800 truncate">
                  جەتوەلا من (خشتەیێ قوتابخانێ)
                </h1>
                <div className="flex items-center gap-1.5 text-[10px] text-slate-500 font-bold truncate mt-0.5">
                  <span className="truncate">{teacherSubject} - {teacherName}</span>
                  <span className="hidden sm:inline-block text-indigo-700 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded-full font-black text-[9px] shrink-0">
                    📅 {getFormattedFullKurdishDate(effectiveTime)}
                  </span>
                </div>
              </div>
            </div>

            {/* Desktop Action Group (> 1024px / lg) */}
            <div className="hidden lg:flex items-center gap-2 shrink-0">
              {/* Search input desktop */}
              <div className="relative w-48 xl:w-60">
                <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={headerSearchQuery}
                  onChange={(e) => {
                    setHeaderSearchQuery(e.target.value);
                    setShowHeaderSearchResults(Boolean(e.target.value.trim()));
                  }}
                  placeholder="🔍 بگەڕێ بۆ مامۆستایان..."
                  className="w-full text-xs py-2 pr-9 pl-3 bg-slate-100 border border-slate-200 rounded-2xl outline-none focus:border-indigo-500 font-bold transition-all"
                />

                {showHeaderSearchResults && headerSearchQuery.trim() && (
                  <div className="absolute right-0 top-full mt-2 w-80 bg-white rounded-2xl shadow-2xl border border-slate-200 p-3 z-50 space-y-2 max-h-96 overflow-y-auto">
                    <div className="flex justify-between items-center text-[11px] font-black text-slate-500 border-b pb-1.5">
                      <span>ئەنجامێن لێگەڕیانێ ({headerSearchQuery})</span>
                      <button onClick={() => setShowHeaderSearchResults(false)} className="text-slate-400 hover:text-slate-700">
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    {allTeachersList
                      .filter(t => 
                        t.teacherName.toLowerCase().includes(headerSearchQuery.toLowerCase()) || 
                        t.subject.toLowerCase().includes(headerSearchQuery.toLowerCase()) ||
                        JSON.stringify(t.schedule).toLowerCase().includes(headerSearchQuery.toLowerCase())
                      )
                      .slice(0, 8)
                      .map((tDoc) => {
                        const summary = getTeacherTodaySummary(tDoc);
                        return (
                          <div
                            key={tDoc.id}
                            onClick={() => {
                              openTeacherLiveStatusModal(tDoc);
                            }}
                            className="p-3 rounded-2xl bg-slate-50 hover:bg-indigo-50/80 border border-slate-200 hover:border-indigo-300 transition-all cursor-pointer space-y-1.5 text-right shadow-xs group"
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-black text-xs text-indigo-950 group-hover:text-indigo-700">
                                {tDoc.teacherName} ({tDoc.subject})
                              </span>
                              <span className="text-[10px] bg-indigo-100 text-indigo-800 font-black px-2 py-0.5 rounded-full">
                                {summary.countToday} وانە ئەڤڕۆ
                              </span>
                            </div>
                            <div className="text-[11px] text-slate-600 font-bold flex items-center justify-between pt-1">
                              <span className="text-emerald-700">📍 جهێ نوکە: {summary.currentClassNow}</span>
                              <span className="text-slate-500">⏱️ دەستنیشانکرن ↗</span>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                )}
              </div>

              {/* Action Buttons Desktop */}
              <button
                onClick={() => setShowTeacherSelectModal(true)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-2xl bg-indigo-50 hover:bg-indigo-100 text-indigo-900 text-xs font-black border border-indigo-200 transition-all shadow-sm active:scale-95"
                title="گۆڕینی مامۆستایێ هەڵبژێردراو"
              >
                <Users className="w-3.5 h-3.5 text-indigo-600" />
                <span>مامۆستا ({allTeachersList.length})</span>
              </button>

              <button
                onClick={() => setShowSwapModal(true)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-2xl bg-purple-50 hover:bg-purple-100 text-purple-900 text-xs font-black border border-purple-200 transition-all shadow-sm active:scale-95"
                title="گۆڕینەوەی وانەکان دگەل مامۆستایان"
              >
                <Shuffle className="w-3.5 h-3.5 text-purple-600" />
                <span>گۆڕینەوەی وانە</span>
              </button>

              <button
                onClick={() => setShowAdminModal(true)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-2xl bg-yellow-50 hover:bg-yellow-100 text-yellow-900 text-xs font-black border border-yellow-300 transition-all shadow-sm active:scale-95"
                title="بەشی ئەدمین و بەڕێوەبەرایەتی"
              >
                <ShieldCheck className="w-3.5 h-3.5 text-yellow-600" />
                <span>ئەدمین</span>
              </button>

              <button
                onClick={() => {
                  setShowWallpaperModal(true);
                  if ("Notification" in window && Notification.permission !== "granted") {
                    Notification.requestPermission();
                  }
                }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-2xl bg-cyan-50 hover:bg-cyan-100 text-cyan-800 text-xs font-black border border-cyan-200 transition-all shadow-sm active:scale-95"
                title="دروستکرنا ڕەسمێ شاشەیا قوفلا مۆبایلێ"
              >
                <Smartphone className="w-3.5 h-3.5 text-cyan-600" />
                <span>شاشەیا قوفلێ</span>
              </button>

              <button
                onClick={() => {
                  setShowWidgetModal(true);
                  setTimeout(renderWidgetCanvas, 50);
                }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-2xl bg-amber-50 hover:bg-amber-100 text-amber-900 text-xs font-black border border-amber-200 transition-all shadow-sm active:scale-95"
                title="ویجێتێن شاشەی"
              >
                <LayoutGrid className="w-3.5 h-3.5 text-amber-600" />
                <span>ویجێت</span>
              </button>

              <button
                onClick={() => setShowAiImportModal(true)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-2xl bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-black border border-indigo-200 transition-all shadow-sm active:scale-95"
              >
                <Sparkles className="w-4 h-4 text-indigo-600" />
                <span>Gemini AI</span>
              </button>

              <button
                onClick={() => setViewMode(viewMode === 'classic' ? 'modern' : 'classic')}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-2xl border text-xs font-black transition-all shadow-sm active:scale-95 ${
                  viewMode === 'classic'
                    ? 'bg-indigo-600 text-white border-indigo-600 shadow-md'
                    : 'bg-indigo-50 hover:bg-indigo-100 text-indigo-900 border-indigo-200'
                }`}
                title="گۆڕینی شێوازی خشتەی گشتی"
              >
                <Grid className="w-3.5 h-3.5 text-yellow-300" />
                <span>{viewMode === 'classic' ? 'شێوازێ مۆدێرن' : 'شێوازێ خشتێ (Table)'}</span>
              </button>

              <button
                onClick={() => setViewMode(viewMode === 'live' ? 'modern' : 'live')}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-2xl border text-xs font-bold transition-all ${
                  viewMode === 'live'
                    ? 'bg-red-500 text-white border-red-500 shadow-md'
                    : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                }`}
              >
                <MonitorPlay className={`w-4 h-4 ${viewMode === 'live' ? 'text-white' : 'text-red-500'}`} />
                <span>مۆدا زیندی</span>
              </button>

              <button
                onClick={() => setShowSettingsModal(true)}
                className="p-2 rounded-2xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 transition-all shadow-sm relative"
                title="ڕێکخستن"
              >
                <Settings className="w-5 h-5" />
                {alarmSettings.examSettings?.enabled && (
                  <span className="absolute -top-1 -right-1 w-3 h-3 bg-purple-600 rounded-full border-2 border-white animate-pulse" />
                )}
              </button>

              <button
                onClick={saveToLocal}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-2xl text-xs font-black transition-all ${
                  isSaved ? 'bg-emerald-600 text-white shadow-md' : 'text-white shadow-md hover:opacity-90'
                }`}
                style={{ backgroundColor: isSaved ? '' : 'var(--primary-color)' }}
              >
                {isSaved ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
                <span>{isSaved ? 'پاراستی' : 'پاشکەفتن'}</span>
              </button>
            </div>

            {/* Mobile & Tablet Top Control Controls (< 1024px / lg) */}
            <div className="flex lg:hidden items-center gap-1.5 shrink-0">
              {/* Quick View Mode Switcher for Mobile */}
              <button
                onClick={() => setViewMode(viewMode === 'classic' ? 'modern' : 'classic')}
                className={`px-2.5 py-1.5 rounded-xl border text-xs font-black flex items-center gap-1 transition-all ${
                  viewMode === 'classic' ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm' : 'bg-indigo-50 text-indigo-900 border-indigo-200'
                }`}
                title="گۆڕینی شێوازی خشتە"
              >
                <Grid className="w-3.5 h-3.5 text-yellow-300" />
                <span>{viewMode === 'classic' ? 'مۆدێرن' : 'خشتە'}</span>
              </button>

              {/* Mobile Search Toggle */}
              <button
                onClick={() => setMobileSearchOpen(!mobileSearchOpen)}
                className={`p-2 rounded-xl border text-xs font-black transition-all ${
                  mobileSearchOpen ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-slate-100 text-slate-700 border-slate-200'
                }`}
                title="گەڕیان"
              >
                <Search className="w-4 h-4" />
              </button>

              {/* Quick Teacher Switch Button */}
              <button
                onClick={() => setShowTeacherSelectModal(true)}
                className="px-2.5 py-1.5 rounded-xl bg-indigo-50 text-indigo-900 text-xs font-black border border-indigo-200 flex items-center gap-1"
              >
                <Users className="w-3.5 h-3.5 text-indigo-600" />
                <span className="hidden sm:inline">مامۆستا</span>
              </button>

              {/* Save Quick Button */}
              <button
                onClick={saveToLocal}
                className="p-2 rounded-xl text-white font-black text-xs shadow-sm transition-all"
                style={{ backgroundColor: isSaved ? '#059669' : 'var(--primary-color)' }}
                title="پاشکەفتن"
              >
                {isSaved ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
              </button>

              {/* Mobile Menu Drawer Toggle Button */}
              <button
                onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
                className="p-2 rounded-xl bg-indigo-600 text-white font-black shadow-md active:scale-95 transition-all flex items-center gap-1"
                aria-label="مێنیو"
              >
                {isMobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
              </button>
            </div>
          </div>

          {/* Mobile Search Input Row */}
          {mobileSearchOpen && (
            <div className="relative w-full lg:hidden pt-1 animate-in slide-in-from-top-1 duration-150">
              <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={headerSearchQuery}
                onChange={(e) => {
                  setHeaderSearchQuery(e.target.value);
                  setShowHeaderSearchResults(Boolean(e.target.value.trim()));
                }}
                placeholder="🔍 بگەڕێ بۆ ناڤێ مامۆستایان یان پۆلان..."
                className="w-full text-xs py-2 pr-9 pl-3 bg-slate-100 border border-slate-200 rounded-xl outline-none font-bold"
              />

              {showHeaderSearchResults && headerSearchQuery.trim() && (
                <div className="absolute right-0 top-full mt-2 w-full bg-white rounded-2xl shadow-2xl border border-slate-200 p-3 z-50 space-y-2 max-h-80 overflow-y-auto">
                  <div className="flex justify-between items-center text-[11px] font-black text-slate-500 border-b pb-1.5">
                    <span>ئەنجامێن لێگەڕیانێ ({headerSearchQuery})</span>
                    <button onClick={() => setShowHeaderSearchResults(false)} className="text-slate-400 hover:text-slate-700">
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  {allTeachersList
                    .filter(t => 
                      t.teacherName.toLowerCase().includes(headerSearchQuery.toLowerCase()) || 
                      t.subject.toLowerCase().includes(headerSearchQuery.toLowerCase()) ||
                      JSON.stringify(t.schedule).toLowerCase().includes(headerSearchQuery.toLowerCase())
                    )
                    .slice(0, 8)
                    .map((tDoc) => {
                      const summary = getTeacherTodaySummary(tDoc);
                      return (
                        <div
                          key={tDoc.id}
                          onClick={() => {
                            openTeacherLiveStatusModal(tDoc);
                            setMobileSearchOpen(false);
                          }}
                          className="p-3 rounded-2xl bg-slate-50 hover:bg-indigo-50/80 border border-slate-200 hover:border-indigo-300 transition-all cursor-pointer space-y-1.5 text-right shadow-xs group"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-black text-xs text-indigo-950 group-hover:text-indigo-700">
                              {tDoc.teacherName} ({tDoc.subject})
                            </span>
                            <span className="text-[10px] bg-indigo-100 text-indigo-800 font-black px-2 py-0.5 rounded-full">
                              {summary.countToday} وانە ئەڤڕۆ
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-600 font-bold flex items-center justify-between pt-1">
                            <span className="text-emerald-700">📍 جهێ نوکە: {summary.currentClassNow}</span>
                            <span className="text-slate-500">⏱️ دەستنیشانکرن ↗</span>
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          )}

          {/* Mobile Collapsible Drawer Grid Menu (< 1024px / lg) */}
          {isMobileMenuOpen && (
            <div className="lg:hidden pt-3 border-t border-slate-200 space-y-2.5 animate-in slide-in-from-top-2 duration-200">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs font-black">
                <button
                  onClick={() => { setViewMode('classic'); setIsMobileMenuOpen(false); }}
                  className={`p-3 rounded-2xl border flex items-center gap-2 active:scale-95 transition-all col-span-2 ${
                    viewMode === 'classic' ? 'bg-indigo-600 text-white border-indigo-600 shadow-md' : 'bg-indigo-50 border-indigo-200 text-indigo-950'
                  }`}
                >
                  <Grid className="w-4 h-4 shrink-0 text-yellow-300" />
                  <span className="truncate">📊 شێوازێ خشتێ گشتی (Classic Matrix Table)</span>
                </button>

                <button
                  onClick={() => { setViewMode('modern'); setIsMobileMenuOpen(false); }}
                  className={`p-3 rounded-2xl border flex items-center gap-2 active:scale-95 transition-all col-span-2 ${
                    viewMode === 'modern' ? 'bg-indigo-600 text-white border-indigo-600 shadow-md' : 'bg-slate-50 border-slate-200 text-slate-800'
                  }`}
                >
                  <Smartphone className="w-4 h-4 shrink-0 text-indigo-500" />
                  <span className="truncate">📱 شێوازێ مۆدێرن (Modern Card View)</span>
                </button>

                <button
                  onClick={() => { setShowTeacherSelectModal(true); setIsMobileMenuOpen(false); }}
                  className="p-3 rounded-2xl bg-indigo-50 border border-indigo-200 text-indigo-900 flex items-center gap-2 active:scale-95 transition-all"
                >
                  <Users className="w-4 h-4 text-indigo-600 shrink-0" />
                  <span className="truncate">مامۆستا ({allTeachersList.length})</span>
                </button>

                <button
                  onClick={() => { setShowSwapModal(true); setIsMobileMenuOpen(false); }}
                  className="p-3 rounded-2xl bg-purple-50 border border-purple-200 text-purple-900 flex items-center gap-2 active:scale-95 transition-all"
                >
                  <Shuffle className="w-4 h-4 text-purple-600 shrink-0" />
                  <span className="truncate">گۆڕینەوەی وانە</span>
                </button>

                <button
                  onClick={() => { setShowAdminModal(true); setIsMobileMenuOpen(false); }}
                  className="p-3 rounded-2xl bg-yellow-50 border border-yellow-300 text-yellow-900 flex items-center gap-2 active:scale-95 transition-all"
                >
                  <ShieldCheck className="w-4 h-4 text-yellow-600 shrink-0" />
                  <span className="truncate">ئەدمین</span>
                </button>

                <button
                  onClick={() => { setShowWallpaperModal(true); setIsMobileMenuOpen(false); }}
                  className="p-3 rounded-2xl bg-cyan-50 border border-cyan-200 text-cyan-800 flex items-center gap-2 active:scale-95 transition-all"
                >
                  <Smartphone className="w-4 h-4 text-cyan-600 shrink-0" />
                  <span className="truncate">شاشەیا قوفلێ</span>
                </button>

                <button
                  onClick={() => { setShowWidgetModal(true); setIsMobileMenuOpen(false); setTimeout(renderWidgetCanvas, 50); }}
                  className="p-3 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 flex items-center gap-2 active:scale-95 transition-all"
                >
                  <LayoutGrid className="w-4 h-4 text-amber-600 shrink-0" />
                  <span className="truncate">ویجێتێن شاشەی</span>
                </button>

                <button
                  onClick={() => { setShowAiImportModal(true); setIsMobileMenuOpen(false); }}
                  className="p-3 rounded-2xl bg-indigo-50 border border-indigo-200 text-indigo-700 flex items-center gap-2 active:scale-95 transition-all"
                >
                  <Sparkles className="w-4 h-4 text-indigo-600 shrink-0" />
                  <span className="truncate">Gemini AI</span>
                </button>

                <button
                  onClick={() => { setViewMode(viewMode === 'live' ? 'modern' : 'live'); setIsMobileMenuOpen(false); }}
                  className={`p-3 rounded-2xl border flex items-center gap-2 active:scale-95 transition-all ${
                    viewMode === 'live' ? 'bg-red-500 text-white border-red-500' : 'bg-white border-slate-200 text-slate-700'
                  }`}
                >
                  <MonitorPlay className="w-4 h-4 shrink-0" />
                  <span className="truncate">مۆدا زیندی</span>
                </button>

                <button
                  onClick={() => { setSettingsActiveTab('storage'); setShowSettingsModal(true); setIsMobileMenuOpen(false); }}
                  className="p-3 rounded-2xl bg-slate-50 border border-slate-200 text-slate-700 flex items-center gap-2 active:scale-95 transition-all"
                >
                  <HardDrive className="w-4 h-4 text-cyan-600 shrink-0" />
                  <span className="truncate">بیرگەی ناوخۆیی</span>
                </button>

                <button
                  onClick={() => { setShowSettingsModal(true); setIsMobileMenuOpen(false); }}
                  className="p-3 rounded-2xl bg-slate-50 border border-slate-200 text-slate-700 flex items-center gap-2 active:scale-95 transition-all"
                >
                  <Settings className="w-4 h-4 text-slate-600 shrink-0" />
                  <span className="truncate">ڕێکخستنێن دەم</span>
                </button>

                <button
                  onClick={() => { saveToLocal(); setIsMobileMenuOpen(false); }}
                  className="p-3 rounded-2xl bg-emerald-600 text-white flex items-center gap-2 active:scale-95 transition-all"
                >
                  <Save className="w-4 h-4 shrink-0" />
                  <span className="truncate">پاشکەفتن</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </header>

      {/* Top View Mode Switcher Pills (Classic Matrix Table vs Modern Cards vs Live Mode) */}
      <div className="max-w-6xl mx-auto px-3 sm:px-4 pt-3 pb-1 no-print">
        <div className="bg-slate-200/90 backdrop-blur-md p-1.5 rounded-2xl flex items-center justify-between gap-1 max-w-md mx-auto text-xs font-black shadow-inner border border-slate-300/50">
          <button
            onClick={() => setViewMode('classic')}
            className={`flex-1 py-2 px-3 rounded-xl transition-all flex items-center justify-center gap-1.5 ${
              viewMode === 'classic'
                ? 'bg-indigo-600 text-white shadow-md scale-[1.02]'
                : 'text-slate-700 hover:bg-slate-300/60'
            }`}
          >
            <Grid className="w-4 h-4 text-yellow-300" />
            <span>شێوازێ خشتێ (Table)</span>
          </button>

          <button
            onClick={() => setViewMode('modern')}
            className={`flex-1 py-2 px-3 rounded-xl transition-all flex items-center justify-center gap-1.5 ${
              viewMode === 'modern'
                ? 'bg-indigo-600 text-white shadow-md scale-[1.02]'
                : 'text-slate-700 hover:bg-slate-300/60'
            }`}
          >
            <Smartphone className="w-4 h-4" />
            <span>مۆدێرن (Cards)</span>
          </button>

          <button
            onClick={() => setViewMode('live')}
            className={`flex-1 py-2 px-3 rounded-xl transition-all flex items-center justify-center gap-1.5 ${
              viewMode === 'live'
                ? 'bg-red-500 text-white shadow-md scale-[1.02]'
                : 'text-slate-700 hover:bg-slate-300/60'
            }`}
          >
            <MonitorPlay className="w-4 h-4" />
            <span>مۆدا زیندی</span>
          </button>
        </div>
      </div>

      {/* Teacher Saved / Change Request Offline & Online Feedback Notification */}
      {teacherSubmittedStatus && (
        <div className="max-w-5xl mx-auto px-3 sm:px-4 pt-2 no-print">
          <div className="p-3.5 sm:p-4 rounded-2xl bg-emerald-600 text-white font-black text-xs shadow-lg flex items-center justify-between gap-3 animate-in slide-in-from-top duration-300">
            <div className="flex items-center gap-2.5">
              <CheckCircle className="w-5 h-5 text-yellow-300 shrink-0" />
              <span>{teacherSubmittedStatus}</span>
            </div>
            <button
              onClick={() => setTeacherSubmittedStatus(null)}
              className="p-1 hover:bg-white/20 rounded-lg text-white transition-all"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Pending Admin Review Banner for the Current Teacher */}
      {changeRequests.some(r => (r.teacherId === selectedTeacherId || r.teacherName === teacherName) && r.status === 'pending') && (
        <div className="max-w-5xl mx-auto px-3 sm:px-4 pt-2 no-print">
          <div className="p-3.5 sm:p-4 rounded-2xl bg-amber-50 border-2 border-amber-300 text-amber-950 font-bold text-xs shadow-xs flex items-center justify-between gap-3 animate-in fade-in">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-amber-200 text-amber-900 rounded-xl shrink-0">
                <Clock className="w-4 h-4 text-amber-700 animate-spin" />
              </div>
              <div>
                <span className="font-black text-amber-900 block">
                  📌 داخوازییا دەستکاریا خشتەیێ تە ڕەوانەی ئەدمین کراوە (چاوەڕوانی پەسەندکردنە):
                </span>
                <span className="text-[11px] text-amber-800 font-medium">
                  خشتەکەت لەسەر ئەم ئامێرە ١٠٠٪ ئۆفلاین کاردەکات و دەستکارییەکانت ماونەتەوە. کاتێک ئەدمین پەسەندی بکات، ل هەموو جەتوەلان بەڵاڤ دەبێت.
                </span>
              </div>
            </div>
            <span className="shrink-0 px-2.5 py-1 bg-amber-200/90 text-amber-950 rounded-full font-black text-[10px]">
              ⏳ چاوەڕوانی ئەدمین
            </span>
          </div>
        </div>
      )}

      {/* VIEW: LIVE MODE */}
      {viewMode === 'live' ? (
        <main className="max-w-5xl mx-auto px-4 pt-8 animate-in fade-in duration-300 flex flex-col items-center justify-center min-h-[75vh] gap-8">
          <div className="text-center space-y-3">
            <div
              className="text-7xl md:text-8xl font-black text-slate-800 tracking-tighter cursor-pointer relative"
              onClick={() => !manualTimeStr && document.getElementById('manual-time-input')?.focus()}
            >
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                {effectiveTime.getHours().toString().padStart(2, '0')}:
                {effectiveTime.getMinutes().toString().padStart(2, '0')}
              </span>
              {manualTimeStr && (
                <span className="absolute -top-3 -right-3 bg-orange-500 text-white text-[10px] px-2 py-0.5 rounded-full animate-pulse">
                  دەستی
                </span>
              )}
            </div>
            <div className="text-lg text-indigo-600 font-black tracking-wide flex items-center justify-center gap-2">
              <span>📅 {getFormattedFullKurdishDate(effectiveTime)}</span>
              {alarmSettings.examSettings?.enabled && (
                <span className="text-xs bg-purple-100 text-purple-700 px-2.5 py-1 rounded-full font-black">
                  ڕۆژا ئیمتیحانێ 📝
                </span>
              )}
            </div>

            {/* Manual time reset */}
            <div className="flex items-center justify-center gap-2">
              {manualTimeStr ? (
                <button
                  onClick={() => setManualTimeStr(null)}
                  className="flex items-center gap-1.5 px-4 py-1.5 bg-slate-200 text-slate-700 rounded-xl text-xs font-bold hover:bg-slate-300"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> زڤڕین بۆ دەمێ نوکە
                </button>
              ) : (
                <div className="relative">
                  <input
                    id="manual-time-input"
                    type="time"
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    onChange={(e) => setManualTimeStr(e.target.value)}
                  />
                  <button className="flex items-center gap-1.5 px-4 py-1.5 border border-slate-200 text-slate-500 rounded-xl text-xs font-bold pointer-events-none bg-white shadow-sm">
                    <Search className="w-3.5 h-3.5" /> تاقیکرنا دەمەکێ دی
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Time Remaining Card */}
          <div className="w-full max-w-xl bg-slate-900 rounded-[2.5rem] p-8 text-white shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 right-0 p-6 opacity-10">
              <Hourglass className="w-24 h-24" />
            </div>
            <div className="relative z-10 text-center">
              <p className="text-slate-400 text-sm font-bold mb-1">
                {manualTimeStr
                  ? 'دەمێ دیارکری (تاقیکردن)'
                  : currentLiveSlot.status === 'active'
                  ? 'دەمێ مای بۆ کۆتاییا وانێ'
                  : currentLiveSlot.status === 'break'
                  ? 'دەمێ مای بۆ دەستپێکرنا وانێ (فرسەت)'
                  : 'دەمێ مای بۆ دەوامێ'}
              </p>
              <div className="text-6xl font-black tracking-tight font-mono">{timeRemaining}</div>
            </div>
          </div>

          {/* Live Slots */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 w-full max-w-3xl">
            {/* Current Lesson */}
            <div
              className={`p-6 rounded-[2rem] border-3 transition-all ${
                currentLiveSlot.status === 'active' || manualTimeStr
                  ? 'bg-green-50 border-green-400'
                  : 'bg-slate-100 border-slate-200 opacity-60'
              }`}
            >
              <div className="flex items-center gap-2 mb-2">
                <div
                  className={`w-3 h-3 rounded-full ${
                    currentLiveSlot.status === 'active' || manualTimeStr ? 'bg-green-500 animate-pulse' : 'bg-slate-400'
                  }`}
                />
                <span className="text-xs font-black text-slate-500 uppercase tracking-widest">
                  وانا نوکە (Active)
                </span>
              </div>
              <h2 className="text-3xl font-black text-slate-800 mb-1">
                {currentLiveSlot.slot
                  ? currentLiveSlot.slot.className === 'بێ وانە'
                    ? 'بەتاڵ (بێ وانە)'
                    : `پۆلا ${currentLiveSlot.slot.className}`
                  : 'هیچ وانەیەک نینە'}
              </h2>
              <p className="text-slate-500 font-bold text-sm">
                {currentLiveSlot.slot ? `${currentLiveSlot.slot.startTime} — ${currentLiveSlot.slot.endTime}` : ''}
              </p>
            </div>

            {/* Next Lesson */}
            <div className="p-6 rounded-[2rem] border-3 bg-indigo-50 border-indigo-200">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-3 h-3 rounded-full bg-indigo-500" />
                <span className="text-xs font-black text-indigo-500 uppercase tracking-widest">
                  وانا داهاتی (Next)
                </span>
              </div>
              <h2 className="text-3xl font-black text-slate-800 mb-1">
                {nextLiveSlot
                  ? nextLiveSlot.className === 'بێ وانە'
                    ? 'بەتاڵ (بێ وانە)'
                    : `پۆلا ${nextLiveSlot.className}`
                  : 'کۆتاییا دەوامی'}
              </h2>
              <p className="text-slate-500 font-bold text-sm">
                {nextLiveSlot ? `${nextLiveSlot.startTime} — ${nextLiveSlot.endTime}` : ''}
              </p>
            </div>
          </div>
        </main>
      ) : viewMode === 'modern' ? (
        /* VIEW: MODERN CARDS */
        <main className="max-w-5xl mx-auto px-4 pt-6 animate-in fade-in duration-300">
          {/* Days bar */}
          <div className="flex overflow-x-auto pb-3 gap-2.5 no-scrollbar scroll-smooth no-print">
            {DAYS.map((day) => {
              const dayShift = getDayShift(day, schedule, alarmSettings);
              const isMorning = dayShift === 'morning';
              return (
                <button
                  key={day}
                  onClick={() => setActiveDay(day)}
                  className={`flex-shrink-0 min-w-[120px] px-5 py-4 rounded-2xl text-xs font-black transition-all border-2 ${
                    activeDay === day
                      ? 'bg-white text-slate-900 shadow-lg -translate-y-0.5'
                      : 'bg-white border-slate-100 text-slate-400 hover:border-slate-200'
                  }`}
                  style={{ borderColor: activeDay === day ? 'var(--primary-color)' : '' }}
                >
                  {day}
                  <div
                    className={`flex items-center justify-center gap-1 mt-1.5 px-2 py-0.5 rounded-full text-[9px] w-fit mx-auto ${
                      isMorning
                        ? 'bg-orange-50 text-orange-600'
                        : 'bg-indigo-50 text-indigo-600'
                    }`}
                  >
                    {isMorning ? (
                      <Sun className="w-2.5 h-2.5" />
                    ) : (
                      <Moon className="w-2.5 h-2.5" />
                    )}
                    <span>{isMorning ? 'سپێدە' : 'نیڤڕۆ'}</span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Active day section */}
          <div className="mt-6 space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-black text-slate-800 flex items-center gap-2">
                  <div className="w-1.5 h-7 rounded-full" style={{ backgroundColor: 'var(--primary-color)' }} />
                  وانێن روژا {activeDay}
                </h2>
                {(() => {
                  const activeShift = getDayShift(activeDay, schedule, alarmSettings);
                  const isMorning = activeShift === 'morning';
                  const duration = isMorning ? alarmSettings.morningDuration : alarmSettings.eveningDuration;
                  return (
                    <p className="text-[11px] text-slate-500 font-bold mt-0.5">
                      دەوام: {isMorning ? 'سپێدە' : 'نیڤڕۆ'} ({duration} خولەک)
                      {alarmSettings.examSettings?.enabled && (
                        <span className="mr-2 text-purple-700 bg-purple-100 px-2 py-0.5 rounded-full text-[10px]">
                          ئیمتیحان: دەرسا {alarmSettings.examSettings.examLessonNumber} (40 خولەک)
                        </span>
                      )}
                    </p>
                  );
                })()}
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => toggleDayShift(activeDay)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 text-slate-700 rounded-xl text-xs font-bold border border-slate-200 hover:bg-slate-200 transition-all"
                >
                  <ArrowLeftRight className="w-3.5 h-3.5" />
                  <span>گوهۆڕینا دەوامێ</span>
                </button>
                <button
                  onClick={() => setShowSettingsModal(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-orange-50 text-orange-700 rounded-xl text-xs font-bold border border-orange-200 hover:bg-orange-100 transition-all"
                >
                  <Clock className="w-3.5 h-3.5" />
                  <span>وەختێ دەرسێ</span>
                </button>
              </div>
            </div>

            {/* Slots Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {(currentDayData?.slots || []).map((slot, index) => {
                const status = getSlotStatus(slot.startTime, slot.endTime);
                let bgColor = 'bg-white';
                let borderColor = 'border-slate-100';
                let statusLabel = '';

                if (status === 'finished') {
                  bgColor = 'bg-red-50/50';
                  borderColor = 'border-red-200';
                  statusLabel = 'خلاس بوو';
                } else if (status === 'active') {
                  bgColor = 'bg-green-50/70';
                  borderColor = 'border-green-300';
                  statusLabel = 'نوکە دهێتە گوتن';
                } else if (status === 'upcoming') {
                  bgColor = 'bg-yellow-50/70';
                  borderColor = 'border-yellow-300';
                  statusLabel = 'دێ دەستپێبکەت';
                }

                const isExamSlot = Boolean(
                  slot.isExam ||
                    (alarmSettings.examSettings?.enabled &&
                      alarmSettings.examSettings.examLessonNumber === index + 1)
                );

                return (
                  <div
                    key={slot.id}
                    className={`group ${bgColor} p-5 rounded-[2rem] border-2 ${borderColor} transition-all hover:shadow-xl ${
                      editingSlotId === slot.id ? 'ring-4 ring-slate-100' : ''
                    } ${isExamSlot ? 'border-purple-300 ring-2 ring-purple-100' : ''}`}
                    style={{ borderColor: editingSlotId === slot.id ? 'var(--primary-color)' : undefined }}
                  >
                    <div className="flex justify-between items-center mb-4">
                      <div className="flex items-center gap-1.5">
                        <span
                          className="text-white text-[10px] font-black px-3 py-1 rounded-full shadow-sm"
                          style={{
                            backgroundColor:
                              status === 'finished'
                                ? '#ef4444'
                                : status === 'active'
                                ? '#22c55e'
                                : status === 'upcoming'
                                ? '#facc15'
                                : isExamSlot
                                ? '#7e22ce'
                                : 'var(--primary-color)',
                          }}
                        >
                          وانا {index + 1}
                        </span>
                        {isExamSlot && (
                          <span className="text-[9px] font-black bg-purple-100 text-purple-700 px-2 py-0.5 rounded-md">
                            ئیمتیحان 📝
                          </span>
                        )}
                        {statusLabel && (
                          <span className="text-[9px] font-bold text-slate-500 uppercase">{statusLabel}</span>
                        )}
                      </div>
                      <button
                        onClick={() => setEditingSlotId(slot.id === editingSlotId ? null : slot.id)}
                        className="p-1.5 text-slate-300 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-all"
                      >
                        <Edit3 className="w-4 h-4" />
                      </button>
                    </div>

                    {editingSlotId === slot.id ? (
                      <div className="space-y-3 animate-in slide-in-from-top-1 duration-200 bg-slate-50/90 p-3 rounded-2xl border border-slate-200">
                        {/* Grade & Section Selection */}
                        <div className="space-y-1.5">
                          <label className="text-[10px] font-black text-slate-500 block">پۆل و هۆبە (قۆناغا 1 هەتا 12):</label>
                          <div className="grid grid-cols-2 gap-2">
                            {/* Quick Grade Select */}
                            <select
                              onChange={(e) => {
                                const selectedGrade = e.target.value;
                                if (!selectedGrade) return;
                                if (selectedGrade === 'بێ وانە') {
                                  updateSlot(activeDay, slot.id, { className: 'بێ وانە' });
                                  return;
                                }
                                const currentParts = slot.className.split(' - ');
                                const currentHuba = currentParts.length > 1 ? currentParts[1] : 'أ';
                                updateSlot(activeDay, slot.id, { className: `${selectedGrade} - ${currentHuba}` });
                              }}
                              className="text-xs border border-slate-200 bg-white rounded-xl p-2 font-bold outline-none"
                              defaultValue=""
                            >
                              <option value="" disabled>هەلبژارتنا پۆلێ (1-12)</option>
                              <option value="بێ وانە">بێ وانە (بەتاڵ)</option>
                              {GRADES.map((g) => (
                                <option key={g} value={g}>{g}</option>
                              ))}
                            </select>

                            {/* Quick Section/Huba Select */}
                            <select
                              onChange={(e) => {
                                const selectedHuba = e.target.value;
                                if (!selectedHuba) return;
                                const currentGrade = slot.className.includes(' - ')
                                  ? slot.className.split(' - ')[0]
                                  : (slot.className === 'بێ وانە' ? 'پۆلا 10' : slot.className);
                                updateSlot(activeDay, slot.id, { className: `${currentGrade} - ${selectedHuba}` });
                              }}
                              className="text-xs border border-slate-200 bg-white rounded-xl p-2 font-bold outline-none"
                              defaultValue=""
                            >
                              <option value="" disabled>هۆبە (پیتێن دەستنیشانکری)</option>
                              {getActiveSections(alarmSettings).map((sec) => (
                                <option key={sec} value={sec}>هۆبە: {sec}</option>
                              ))}
                            </select>
                          </div>

                          {/* Custom Class Name Text Input */}
                          <input
                            type="text"
                            value={slot.className}
                            onChange={(e) => updateSlot(activeDay, slot.id, { className: e.target.value })}
                            placeholder="یان بنڤیسە: بۆ نموونە 10 - ب"
                            className="w-full text-xs border border-slate-200 bg-white rounded-xl p-2 outline-none font-bold"
                            list="custom-classes-list"
                          />
                          <datalist id="custom-classes-list">
                            {CLASSES.map((c) => (
                              <option key={c} value={c} />
                            ))}
                          </datalist>
                        </div>

                        {/* Subject Selection */}
                        <div>
                          <label className="text-[10px] font-black text-slate-500 block mb-1">بابەت (وانە):</label>
                          <select
                            value={slot.subject || 'کیمیا'}
                            onChange={(e) => updateSlot(activeDay, slot.id, { subject: e.target.value })}
                            className="w-full text-xs border border-slate-200 bg-white rounded-xl p-2 font-bold outline-none"
                          >
                            {ALL_SUBJECTS.map((sub) => (
                              <option key={sub} value={sub}>{sub}</option>
                            ))}
                          </select>
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <label className="text-[10px] font-bold text-slate-400 block mb-1">دەستپێک:</label>
                            <input
                              type="time"
                              value={slot.startTime}
                              onChange={(e) => updateSlot(activeDay, slot.id, { startTime: e.target.value })}
                              className="w-full text-xs border border-slate-200 bg-white rounded-xl p-2 outline-none tabular-nums font-bold"
                            />
                          </div>
                          <div>
                            <label className="text-[10px] font-bold text-slate-400 block mb-1">کۆتایی:</label>
                            <input
                              type="time"
                              value={slot.endTime}
                              onChange={(e) => updateSlot(activeDay, slot.id, { endTime: e.target.value })}
                              className="w-full text-xs border border-slate-200 bg-white rounded-xl p-2 outline-none tabular-nums font-bold"
                            />
                          </div>
                        </div>

                        <button
                          onClick={() => {
                            handleTeacherSaveAndSubmitChange(schedule);
                            setEditingSlotId(null);
                          }}
                          className="w-full text-white py-2.5 rounded-xl text-xs font-black shadow-md active:scale-95 transition-all flex items-center justify-center gap-1.5"
                          style={{ backgroundColor: 'var(--primary-color)' }}
                        >
                          <Save className="w-4 h-4" />
                          <span>پاشکەفتن (خەزنکرنا ئۆفلاین + ناردن بۆ ئەدمین)</span>
                        </button>
                      </div>
                    ) : (
                      <div onClick={() => setEditingSlotId(slot.id)} className="cursor-pointer">
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <h3
                            className={`text-2xl font-black tracking-tight ${
                              status === 'finished'
                                ? 'text-red-700'
                                : status === 'active'
                                ? 'text-green-700'
                                : 'text-slate-800'
                            }`}
                          >
                            {slot.className === 'بێ وانە' ? 'بەتاڵ (بێ وانە)' : (slot.className.startsWith('پۆلا') ? slot.className : `پۆلا ${slot.className}`)}
                          </h3>

                          {slot.className !== 'بێ وانە' && (
                            <span className="flex items-center gap-1 text-[11px] font-black px-2.5 py-1 rounded-xl bg-indigo-50 text-indigo-700 border border-indigo-100 shadow-xs">
                              <GraduationCap className="w-3.5 h-3.5 text-indigo-500" />
                              <span>{slot.subject || 'کیمیا'}</span>
                            </span>
                          )}
                        </div>

                        <div
                          className={`flex items-center gap-2 p-3 rounded-xl border transition-colors ${
                            status === 'active' ? 'bg-green-100/60 border-green-200' : 'bg-slate-50 border-slate-100'
                          }`}
                        >
                          <Clock
                            className={`w-4 h-4 ${status === 'active' ? 'text-green-600' : ''}`}
                            style={{ color: status === 'active' ? '' : 'var(--primary-color)' }}
                          />
                          <span
                            className={`text-xs font-black tabular-nums ${
                              status === 'active' ? 'text-green-800' : 'text-slate-700'
                            }`}
                          >
                            {slot.startTime} — {slot.endTime}
                          </span>
                        </div>

                        {/* Break indicator */}
                        {index === (alarmSettings.longBreakLesson ? alarmSettings.longBreakLesson - 1 : 2) && (
                          <div className="mt-2.5 flex items-center gap-1.5 text-[10px] font-bold text-amber-700 bg-amber-50 px-2.5 py-1 rounded-full w-fit">
                            <Coffee className="w-3 h-3 text-amber-600" />
                            <span>بهێنڤەدانا مەزن ({alarmSettings.longBreakDuration || 10} خولەک)</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </main>
      ) : (
        /* VIEW: CLASSIC TABLE (PRINTABLE / DESKTOP VIEW) */
        <main className="max-w-6xl mx-auto px-4 pt-6 pb-12 animate-in fade-in duration-300 space-y-4">
          {/* Gemini AI Action Bar for Table View */}
          <div className="bg-gradient-to-r from-indigo-900 via-indigo-800 to-purple-900 rounded-3xl p-4 sm:p-5 text-white shadow-xl flex flex-wrap items-center justify-between gap-4 border border-indigo-700/50 no-print">
            <div className="flex items-center gap-3.5">
              <div className="p-3 bg-white/10 backdrop-blur-md rounded-2xl border border-white/20 shadow-inner">
                <Sparkles className="w-6 h-6 text-yellow-300 animate-spin-slow" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-black text-base text-white">زیرەکییا دەستکرد (Gemini AI) د جەتوەلێ دا</h3>
                  <span className="bg-yellow-400 text-slate-950 text-[10px] font-black px-2 py-0.5 rounded-full uppercase tracking-wider">
                    چالاکە
                  </span>
                </div>
                <p className="text-xs text-indigo-200 mt-0.5">
                  وێنەیێ جەتوەلا وانان باربکە، ئێکسەر دێ هێتە شیکارکرن و تەوزیعکرن د ڤێ خشتەیێ دا
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => setShowAiImportModal(true)}
                className="flex items-center gap-2 px-5 py-2.5 rounded-2xl bg-white text-indigo-900 hover:bg-yellow-300 hover:text-slate-950 font-black text-xs shadow-lg active:scale-95 transition-all"
              >
                <Sparkles className="w-4 h-4 text-indigo-600" />
                <span>سکەن و هێنانا جەتوەلێ ب Gemini AI</span>
              </button>
              {!isStandalone && (
                <button
                  onClick={triggerInstallApp}
                  className="flex items-center gap-1.5 px-4 py-2.5 rounded-2xl bg-emerald-500 hover:bg-emerald-400 text-white font-bold text-xs shadow-md active:scale-95 transition-all"
                >
                  <Download className="w-4 h-4" />
                  <span>دابەزاندنا ئەپێ (PWA)</span>
                </button>
              )}
              <button
                onClick={exportLocalStorageBackup}
                className="flex items-center gap-1.5 px-4 py-2.5 rounded-2xl bg-white/15 hover:bg-white/25 text-white font-bold text-xs border border-white/20 backdrop-blur-sm active:scale-95 transition-all"
                title="داگرتنی کۆپییەکی یەدەگی داتای LocalStorage"
              >
                <ArrowDownToLine className="w-4 h-4 text-cyan-300" />
                <span>داگرتنا Backup</span>
              </button>
              <button
                onClick={() => {
                  setSettingsActiveTab('ai');
                  setShowSettingsModal(true);
                }}
                className="flex items-center gap-1.5 px-4 py-2.5 rounded-2xl bg-white/15 hover:bg-white/25 text-white font-bold text-xs border border-white/20 backdrop-blur-sm active:scale-95 transition-all"
              >
                <Wand2 className="w-4 h-4 text-indigo-200" />
                <span>ڕێکخستنا وەختی ب دەق (AI)</span>
              </button>
            </div>
          </div>

          {/* Table Header Bar & Mobile Fit / Theme Controls */}
          <div className="bg-white p-3 sm:p-5 shadow-xl border border-slate-200/80 rounded-3xl space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3 border-slate-100">
              <div className="text-right">
                <h2 className="text-base sm:text-xl font-black text-slate-800 flex items-center gap-2">
                  <LayoutGrid className="w-5 h-5 text-indigo-600" />
                  <span>جەتوەلا وانێن {teacherSubject} - {teacherName}</span>
                </h2>
                <div className="text-[11px] sm:text-xs text-slate-500 font-bold mt-0.5">
                  {alarmSettings.lessonCount || 6} دەرس | سپێدە {alarmSettings.morningDuration} خولەک | هێڤاری {alarmSettings.eveningDuration} خولەک
                </div>
              </div>

              {/* Action Buttons & Mobile Screen Fit Toggle */}
              <div className="flex flex-wrap items-center gap-2 no-print">
                <button
                  onClick={() => {
                    const next = !fitMobileScreen;
                    setFitMobileScreen(next);
                    localStorage.setItem('fit_mobile_screen', JSON.stringify(next));
                  }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-black border transition-all active:scale-95 ${
                    fitMobileScreen
                      ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm'
                      : 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200'
                  }`}
                  title="گونجاندنا خشتەیی بۆ سەر شاشەیا مۆبایلێ"
                >
                  <Smartphone className="w-3.5 h-3.5" />
                  <span>{fitMobileScreen ? '📱 د ئێک شاشەدا (Fit Screen)' : '↔️ شێوازێ پان (Scroll)'}</span>
                </button>

                {/* Soft Pastel Theme Switcher */}
                <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl border border-slate-200 text-[11px] font-bold">
                  <span className="text-slate-500 hidden sm:inline px-1">رەنگێن پاستێل:</span>
                  <button
                    onClick={() => { setTablePastelTheme('rose'); localStorage.setItem('table_pastel_theme', 'rose'); }}
                    className={`px-2 py-0.5 rounded-lg font-bold transition-all ${tablePastelTheme === 'rose' ? 'bg-rose-500 text-white font-black shadow-xs' : 'text-slate-600 hover:bg-slate-200'}`}
                  >
                    🌸 گوڵی
                  </button>
                  <button
                    onClick={() => { setTablePastelTheme('indigo'); localStorage.setItem('table_pastel_theme', 'indigo'); }}
                    className={`px-2 py-0.5 rounded-lg font-bold transition-all ${tablePastelTheme === 'indigo' ? 'bg-indigo-600 text-white font-black shadow-xs' : 'text-slate-600 hover:bg-slate-200'}`}
                  >
                    💜 بنەوشەیی
                  </button>
                  <button
                    onClick={() => { setTablePastelTheme('emerald'); localStorage.setItem('table_pastel_theme', 'emerald'); }}
                    className={`px-2 py-0.5 rounded-lg font-bold transition-all ${tablePastelTheme === 'emerald' ? 'bg-emerald-600 text-white font-black shadow-xs' : 'text-slate-600 hover:bg-slate-200'}`}
                  >
                    🌿 سەوز
                  </button>
                  <button
                    onClick={() => { setTablePastelTheme('amber'); localStorage.setItem('table_pastel_theme', 'amber'); }}
                    className={`px-2 py-0.5 rounded-lg font-bold transition-all ${tablePastelTheme === 'amber' ? 'bg-amber-500 text-white font-black shadow-xs' : 'text-slate-600 hover:bg-slate-200'}`}
                  >
                    ☀️ زێڕینی
                  </button>
                </div>

                <button
                  onClick={() => setShowAiImportModal(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs font-black border border-indigo-200 shadow-xs transition-all"
                >
                  <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
                  <span className="hidden sm:inline">Gemini AI</span>
                </button>

                <button
                  onClick={() => window.print()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold border border-slate-200 shadow-xs transition-all"
                >
                  <span>چاپ (Print)</span>
                </button>
              </div>
            </div>

            {/* Table Color Legend Banner */}
            <div className="flex flex-wrap items-center justify-between text-[11px] font-bold text-slate-600 px-1 pt-1 gap-2">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <span className={`w-3.5 h-3.5 rounded-md border ${
                    tablePastelTheme === 'rose'
                      ? 'bg-rose-100 border-rose-300'
                      : tablePastelTheme === 'emerald'
                      ? 'bg-emerald-100 border-emerald-300'
                      : tablePastelTheme === 'amber'
                      ? 'bg-amber-100 border-amber-300'
                      : 'bg-indigo-100 border-indigo-300'
                  }`} />
                  <span className="text-slate-700 font-extrabold">وانێن هەی (درس دار):</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-3.5 h-3.5 rounded-md bg-slate-100 border border-slate-300" />
                  <span className="text-slate-500 font-medium">بێ وانە (بەتاڵ / فەراغ):</span>
                </div>
              </div>
              <span className="text-[10px] text-slate-400">💡 کلیک ل هەر وانەیەکێ بکە بۆ دەستکاریکرنێ</span>
            </div>

            {/* Main Schedule Matrix Table (Mobile Screen-Fitting Layout) */}
            <div className={`w-full transition-all ${
              fitMobileScreen ? 'overflow-hidden' : 'overflow-x-auto'
            }`}>
              <table className={`w-full text-center border-collapse ${
                fitMobileScreen ? 'table-fixed min-w-0' : 'min-w-[750px]'
              }`}>
                <thead>
                  <tr className="bg-slate-100/90 text-slate-800 border-b-2 border-slate-200 text-xs font-black">
                    <th className="p-1 sm:p-2.5 border-l border-slate-200 w-[18%] sm:w-[14%]">
                      <span>ڕۆژ</span>
                    </th>
                    {Array.from({ length: alarmSettings.lessonCount || 6 }).map((_, i) => (
                      <th key={i} className="p-1 sm:p-2.5 border-l border-slate-200 font-black text-xs sm:text-base text-slate-800">
                        <div className="flex flex-col items-center justify-center">
                          <span>{i + 1}</span>
                          {alarmSettings.examSettings?.enabled && alarmSettings.examSettings.examLessonNumber === i + 1 && (
                            <span className="text-[7px] sm:text-[9px] font-black text-purple-800 bg-purple-100 px-1 rounded">ئیمتیحان</span>
                          )}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {DAYS.map((day) => {
                    const shift = getDayShift(day, schedule, alarmSettings);
                    const isMorning = shift === 'morning';
                    return (
                      <tr key={day} className="border-b border-slate-200 hover:bg-slate-50/50 transition-all">
                        {/* Day & Shift cell */}
                        <td className="p-1 sm:p-2 border-l border-slate-200 font-black bg-slate-50 text-[10px] sm:text-sm text-slate-800">
                          <div className="flex flex-col items-center justify-center gap-0.5 sm:gap-1">
                            <span className="leading-tight">{day}</span>
                            <span className={`text-[8px] sm:text-[10px] font-extrabold px-1.5 py-0.2 rounded-full flex items-center gap-0.5 ${
                              isMorning ? 'bg-amber-100/90 text-amber-900' : 'bg-indigo-100/90 text-indigo-900'
                            }`}>
                              {isMorning ? <Sun className="w-2.5 h-2.5 text-amber-600 shrink-0" /> : <Moon className="w-2.5 h-2.5 text-indigo-600 shrink-0" />}
                              <span className="hidden sm:inline">{isMorning ? 'سپێدە' : 'نیڤڕۆ'}</span>
                            </span>
                          </div>
                        </td>

                        {/* Periods Cells */}
                        {(schedule[day]?.slots || []).map((slot, i) => {
                          const isFilled = slot.className && slot.className !== 'بێ وانە' && slot.className !== 'فەراغ';
                          const status = getSlotStatus(slot.startTime, slot.endTime);
                          const isToday = day === getKurdishDayName(new Date());

                          // Pastel theme styles for filled vs empty
                          let slotStyle = '';
                          if (isFilled) {
                            let baseTheme = '';
                            if (tablePastelTheme === 'rose') {
                              baseTheme = 'bg-pink-100/90 text-rose-950 border border-pink-300/90 shadow-xs hover:bg-pink-200/90';
                            } else if (tablePastelTheme === 'emerald') {
                              baseTheme = 'bg-emerald-100/90 text-emerald-950 border border-emerald-300/90 shadow-xs hover:bg-emerald-200/90';
                            } else if (tablePastelTheme === 'amber') {
                              baseTheme = 'bg-amber-100/90 text-amber-950 border border-amber-300/90 shadow-xs hover:bg-amber-200/90';
                            } else {
                              // indigo default
                              baseTheme = 'bg-indigo-100/90 text-indigo-950 border border-indigo-300/90 shadow-xs hover:bg-indigo-200/90';
                            }

                            if (status === 'active' && isToday) {
                              slotStyle = `${baseTheme} ring-2 ring-emerald-500 font-black animate-pulse shadow-md`;
                            } else {
                              slotStyle = baseTheme;
                            }
                          } else {
                            // EMPTY / FREE SLOT COLOR
                            slotStyle = 'bg-slate-100/70 text-slate-400 border border-dashed border-slate-300/80 hover:bg-slate-200/70';
                          }

                          return (
                            <td
                              key={slot.id || i}
                              onClick={() => {
                                setActiveDay(day);
                                setViewMode('modern');
                                setEditingSlotId(slot.id);
                              }}
                              className="p-0.5 sm:p-1.5 border-l border-slate-200 cursor-pointer transition-all"
                            >
                              <div className={`w-full h-full min-h-[46px] sm:min-h-[75px] p-1 rounded-xl flex flex-col items-center justify-center transition-all ${slotStyle}`}>
                                {isFilled ? (
                                  <>
                                    <span className="text-[10px] sm:text-base md:text-lg font-black tracking-tight leading-tight">
                                      {slot.className}
                                    </span>
                                    <span className="text-[7px] sm:text-[10px] font-bold opacity-80 mt-0.5 truncate max-w-full">
                                      {slot.subject || teacherSubject}
                                    </span>
                                    <span className="text-[7px] sm:text-[9px] font-mono opacity-70 mt-0.5 hidden sm:inline-block">
                                      {slot.startTime}
                                    </span>
                                  </>
                                ) : (
                                  <div className="flex flex-col items-center justify-center text-[9px] sm:text-xs font-medium text-slate-400">
                                    <span className="opacity-50">—</span>
                                    <span className="text-[7px] sm:text-[9px] opacity-60">بێ وانە</span>
                                  </div>
                                )}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </main>
      )}

      {/* Mobile Bottom Navigation Bar */}
      <footer className="fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur-xl border-t border-slate-200 px-3 py-2 flex items-center justify-around z-40 lg:hidden no-print shadow-2xl">
        <button
          onClick={() => setShowTeacherSelectModal(true)}
          className="flex flex-col items-center gap-0.5 text-indigo-700 active:scale-90 transition-all"
        >
          <Users className="w-5 h-5" />
          <span className="text-[10px] font-black">مامۆستا</span>
        </button>

        <button
          onClick={() => setShowSwapModal(true)}
          className="flex flex-col items-center gap-0.5 text-purple-700 active:scale-90 transition-all"
        >
          <Shuffle className="w-5 h-5" />
          <span className="text-[10px] font-black">گۆڕینەوە</span>
        </button>

        {/* Center Save Button */}
        <div
          className="w-13 h-13 rounded-full flex items-center justify-center -mt-6 shadow-xl border-4 border-white active:scale-90 transition-all cursor-pointer text-white"
          onClick={saveToLocal}
          style={{ backgroundColor: isSaved ? '#059669' : 'var(--primary-color)' }}
          title="پاشکەفتن"
        >
          {isSaved ? <CheckCircle className="w-6 h-6" /> : <Save className="w-6 h-6" />}
        </div>

        <button
          onClick={() => setShowAdminModal(true)}
          className="flex flex-col items-center gap-0.5 text-yellow-700 active:scale-90 transition-all"
        >
          <ShieldCheck className="w-5 h-5" />
          <span className="text-[10px] font-black">ئەدمین</span>
        </button>

        <button
          onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          className={`flex flex-col items-center gap-0.5 active:scale-90 transition-all ${
            isMobileMenuOpen ? 'text-indigo-600 font-extrabold' : 'text-slate-600'
          }`}
        >
          {isMobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          <span className="text-[10px] font-black">مێنیو</span>
        </button>
      </footer>

      <style>{`
        @keyframes ring { 0% { transform: rotate(0); } 5% { transform: rotate(15deg); } 10% { transform: rotate(-15deg); } 15% { transform: rotate(12deg); } 20% { transform: rotate(-12deg); } 25% { transform: rotate(0); } 100% { transform: rotate(0); } }
        .animate-ring { animation: ring 1.5s infinite ease-in-out; }
        .no-scrollbar::-webkit-scrollbar { display: none; }
        @media print { .no-print { display: none !important; } body { background: white !important; } }
      `}</style>
    </div>
  );
};

export default App;
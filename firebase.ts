import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { 
  getFirestore, 
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  doc, 
  getDoc, 
  getDocs, 
  setDoc, 
  updateDoc, 
  deleteDoc, 
  collection, 
  onSnapshot,
  getDocFromServer
} from 'firebase/firestore';
import firebaseConfig from './firebase-applet-config.json';

const app = initializeApp(firebaseConfig);

let firestoreInstance;
try {
  firestoreInstance = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager()
    })
  }, firebaseConfig.firestoreDatabaseId);
} catch (err) {
  firestoreInstance = getFirestore(app, firebaseConfig.firestoreDatabaseId);
}

export const db = firestoreInstance;
export const auth = getAuth(app);

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Test connectivity on boot
async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn("Firestore client is offline or starting up.");
    }
  }
}
testConnection();

// Timetables Helper API
export const TIMETABLES_COLLECTION = 'timetables';

export async function fetchTimetablesFromFirestore() {
  try {
    const querySnapshot = await getDocs(collection(db, TIMETABLES_COLLECTION));
    const items: any[] = [];
    querySnapshot.forEach((docSnap) => {
      items.push({ id: docSnap.id, ...docSnap.data() });
    });
    return items;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, TIMETABLES_COLLECTION);
    return [];
  }
}

export async function saveTimetableToFirestore(id: string, data: any) {
  try {
    const docRef = doc(db, TIMETABLES_COLLECTION, id);
    await setDoc(docRef, { ...data, updatedAt: new Date().toISOString() }, { merge: true });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `${TIMETABLES_COLLECTION}/${id}`);
  }
}

export async function batchSaveTimetablesToFirestore(items: any[]) {
  try {
    for (const item of items) {
      if (!item.id && item.teacherName) {
        item.id = `teacher_${item.teacherName.replace(/\s+/g, '_')}`;
      }
      if (item.id) {
        const docRef = doc(db, TIMETABLES_COLLECTION, item.id);
        await setDoc(docRef, { ...item, updatedAt: new Date().toISOString() }, { merge: true });
      }
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, TIMETABLES_COLLECTION);
  }
}

export async function deleteTimetableFromFirestore(id: string) {
  try {
    const docRef = doc(db, TIMETABLES_COLLECTION, id);
    await deleteDoc(docRef);
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `${TIMETABLES_COLLECTION}/${id}`);
  }
}

// School Master Global Settings Collection (Syncs Shifts, Timings, Bells, Exams to Everyone)
export const SCHOOL_SETTINGS_COLLECTION = 'school_settings';
export const SETTINGS_GLOBAL_DOC = 'global_config';

export async function fetchSchoolSettingsFromFirestore(): Promise<any | null> {
  try {
    const docRef = doc(db, SCHOOL_SETTINGS_COLLECTION, SETTINGS_GLOBAL_DOC);
    const docSnap = await getDoc(docRef);
    if (docSnap.exists()) {
      return docSnap.data();
    }
    return null;
  } catch (err) {
    console.warn("Could not fetch school settings from firestore:", err);
    return null;
  }
}

export async function saveSchoolSettingsToFirestore(settings: any) {
  try {
    const docRef = doc(db, SCHOOL_SETTINGS_COLLECTION, SETTINGS_GLOBAL_DOC);
    await setDoc(docRef, { ...settings, updatedAt: new Date().toISOString() }, { merge: true });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `${SCHOOL_SETTINGS_COLLECTION}/${SETTINGS_GLOBAL_DOC}`);
  }
}

// Schedule Change Requests Collection (Teacher proposed edits sent to Admin for approval)
export const SCHEDULE_CHANGE_REQUESTS_COLLECTION = 'schedule_change_requests';

export async function submitScheduleChangeRequest(req: any): Promise<boolean> {
  try {
    const docRef = doc(db, SCHEDULE_CHANGE_REQUESTS_COLLECTION, req.id);
    await setDoc(docRef, { ...req, updatedAt: new Date().toISOString() }, { merge: true });
    return true;
  } catch (err) {
    console.warn("Could not submit change request to Firestore (offline fallback active):", err);
    return false;
  }
}

export async function updateScheduleChangeRequestStatus(
  id: string, 
  status: 'approved' | 'rejected', 
  adminNotes: string = ''
): Promise<boolean> {
  try {
    const docRef = doc(db, SCHEDULE_CHANGE_REQUESTS_COLLECTION, id);
    await updateDoc(docRef, {
      status,
      adminNotes,
      reviewedAt: new Date().toISOString()
    });
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `${SCHEDULE_CHANGE_REQUESTS_COLLECTION}/${id}`);
    return false;
  }
}

export async function deleteScheduleChangeRequest(id: string): Promise<boolean> {
  try {
    const docRef = doc(db, SCHEDULE_CHANGE_REQUESTS_COLLECTION, id);
    await deleteDoc(docRef);
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `${SCHEDULE_CHANGE_REQUESTS_COLLECTION}/${id}`);
    return false;
  }
}




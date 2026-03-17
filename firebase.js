// Firebase initialization and exports
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-analytics.js";
import {
    getAuth,
    onAuthStateChanged,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signOut
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";
import {
    getFirestore,
    doc,
    setDoc,
    getDoc
} from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";

// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyBFzjlcsksXYCdYpytUd-WpBT3XwTi9Pic",
  authDomain: "compscilevel.firebaseapp.com",
  projectId: "compscilevel",
  storageBucket: "compscilevel.firebasestorage.app",
  messagingSenderId: "687287366740",
  appId: "1:687287366740:web:b1e35b370be4952abbe9c1",
  measurementId: "G-NVGGES4RJ4"
};

const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const auth = getAuth(app);
const db = getFirestore(app);

// re-export functions for ease of use
export {
    auth,
    db,
    doc,
    setDoc,
    getDoc,
    onAuthStateChanged,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signOut
};
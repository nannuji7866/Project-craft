"use client";

import React, { createContext, useContext, useEffect, useState } from 'react';
import { User, signInWithPopup, signOut as firebaseSignOut } from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db, googleProvider } from '../lib/firebase';
import { handleFirestoreError, OperationType } from '../lib/firestore-error';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  signInWithGoogle: async () => {},
  signOut: async () => {},
});

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged(async (currentUser) => {
      setUser(currentUser);
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const signInWithGoogle = async () => {
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const user = result.user;
      
      // Check if user profile exists, if not create it
      const userRef = doc(db, 'users', user.uid);
      try {
        const userSnap = await getDoc(userRef);
        if (!userSnap.exists()) {
          const userData: any = {
            uid: user.uid,
            email: user.email,
            createdAt: serverTimestamp()
          };
          if (user.displayName) userData.displayName = user.displayName;
          if (user.photoURL) userData.photoURL = user.photoURL;
          
          await setDoc(userRef, userData);
        }
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, `users/${user.uid}`);
      }
    } catch (error) {
      console.error("Error signing in with Google", error);
      throw error;
    }
  };

  const signOut = async () => {
    try {
      await firebaseSignOut(auth);
    } catch (error) {
      console.error("Error signing out", error);
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, signInWithGoogle, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

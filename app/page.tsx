"use client";

import { useState, useRef, useMemo, useEffect, useCallback } from "react";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Loader2, FileText, Sparkles, AlertCircle, Upload, Download, Settings, CheckCircle2, RefreshCw, MinusCircle, PlusCircle, FileSearch, ArrowRight, LogOut, LogIn, ImagePlus, FileDown, Save } from "lucide-react";
import * as mammoth from "mammoth";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, AlignmentType } from "docx";
import { useAuth } from "../components/AuthProvider";
import Image from "next/image";
import { motion, AnimatePresence } from "motion/react";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import { db, auth } from "../lib/firebase";
import { addDoc, collection, serverTimestamp, getDocs, query, orderBy, deleteDoc, doc, setDoc } from "firebase/firestore";

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  // We don't throw here to avoid crashing the app, but we log it.
  // In a real app, you might want to show a toast or error message.
}

const SYSTEM_PROMPT = `You are analyzing and editing a student project document uploaded by the user.

Your tasks:

---

STEP 1: DOCUMENT ANALYSIS

- Read the full document carefully
- Identify structure:
  - Chapters (e.g., Chapter 1, Chapter 2)
  - Subsections (e.g., 1.1, 1.2, 2.1, etc.)
- Maintain original formatting and flow

---

STEP 2: SECTION EXTRACTION

- Break the document into editable sections
- Each section should be clearly separated
- Preserve original text exactly

---

STEP 3: EDITING MODE

When user selects a section and gives instruction:

- Apply only the requested changes
- Do NOT affect other sections
- Maintain same writing style
- Keep format consistent

---

RULES:

- Do NOT rewrite entire document unless asked
- Do NOT change numbering or headings
- Maintain student-level natural English
- Ensure edited content blends perfectly

---

OUTPUT:

Return only the updated section OR structured sections if in analysis mode`;

export default function Page() {
  const [mode, setMode] = useState<"none" | "select" | "direct-edit" | "generate">("none");
  const { user, loading, signInWithGoogle, signOut } = useAuth();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [referenceText, setReferenceText] = useState("");
  const [analysis, setAnalysis] = useState("");
  
  const handleSignIn = async () => {
    setError("");
    try {
      await signInWithGoogle();
    } catch (error: any) {
      console.error("Sign-in error:", error);
      if (error?.code === 'auth/popup-blocked') {
        setError("Sign-in popup was blocked by your browser. Please allow popups for this site and try again.");
      } else if (error?.code === 'auth/unauthorized-domain') {
        setError(`Domain not authorized. Please add ${window.location.hostname} to your Firebase Auth Authorized Domains.`);
      } else {
        setError(error?.message || "An error occurred during sign-in. Please try again.");
      }
    }
  };
  
  // Form State
  const [topic, setTopic] = useState("");
  const [topicDescription, setTopicDescription] = useState("");
  const [pagesCount, setPagesCount] = useState(10);
  const [level, setLevel] = useState("BBA Student");
  const [sampleSize, setSampleSize] = useState("113");
  const [ageGroup, setAgeGroup] = useState("Age 18–25");
  const [area, setArea] = useState("Chamba");
  const [placeholders, setPlaceholders] = useState(true);
  
  // Output State
  const [output, setOutput] = useState("");
  const [loadingStage, setLoadingStage] = useState<'idle' | 'analyzing' | 'generating' | 'modifying' | 'regenerating_page' | 'editing'>('idle');
  const [activeRegenerateIndex, setActiveRegenerateIndex] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [isDraftsModalOpen, setIsDraftsModalOpen] = useState(false);
  const [drafts, setDrafts] = useState<any[]>([]);
  const [isLoadingDrafts, setIsLoadingDrafts] = useState(false);
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);

  const fetchDrafts = async () => {
    if (!user || user.uid === 'guest') return;
    setIsLoadingDrafts(true);
    try {
      const q = query(collection(db, "users", user.uid, "drafts"), orderBy("updatedAt", "desc"));
      const querySnapshot = await getDocs(q);
      const draftsData = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setDrafts(draftsData);
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, `users/${user.uid}/drafts`);
      setError("Failed to load drafts.");
    } finally {
      setIsLoadingDrafts(false);
    }
  };

  const loadDraft = (draft: any) => {
    setCurrentDraftId(draft.id);
    setTopic(draft.topic || "");
    setOutput(draft.content || "");
    setPagesCount(draft.pagesCount || 10);
    setLevel(draft.level || "BBA Student");
    setSampleSize(draft.sampleSize || "113");
    setAgeGroup(draft.ageGroup || "Age 18–25");
    setArea(draft.area || "Chamba");
    setPlaceholders(draft.placeholders !== undefined ? draft.placeholders : true);
    setStep(3);
    setProjectGenerated(true);
    setIsDraftsModalOpen(false);
  };

  const deleteDraft = async (draftId: string) => {
    if (!user || user.uid === 'guest') return;
    try {
      await deleteDoc(doc(db, "users", user.uid, "drafts", draftId));
      setDrafts(prev => prev.filter(d => d.id !== draftId));
      if (currentDraftId === draftId) setCurrentDraftId(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `users/${user.uid}/drafts/${draftId}`);
      setError("Failed to delete draft.");
    }
  };

  const saveDraft = async () => {
    if (!user || user.uid === 'guest') {
      setError("Please sign in to save drafts.");
      return;
    }
    if (!output) {
      setError("No content to save as draft.");
      return;
    }

    setIsSavingDraft(true);
    setError("");
    setSaveSuccess(false);

    try {
      const draftData = {
        uid: user.uid,
        topic,
        content: output,
        pagesCount,
        level,
        sampleSize,
        ageGroup,
        area,
        placeholders,
        updatedAt: serverTimestamp(),
      };

      if (currentDraftId) {
        await setDoc(doc(db, "users", user.uid, "drafts", currentDraftId), {
          ...draftData,
        }, { merge: true });
      } else {
        const docRef = await addDoc(collection(db, "users", user.uid, "drafts"), {
          ...draftData,
          createdAt: serverTimestamp(),
        });
        setCurrentDraftId(docRef.id);
      }
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: any) {
      handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/drafts/${currentDraftId || 'new'}`);
      setError("Failed to save draft. Please try again.");
    } finally {
      setIsSavingDraft(false);
    }
  };
  const [isExporting, setIsExporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // AI Edit State
  const [selectionRect, setSelectionRect] = useState<{ top: number; left: number } | null>(null);
  const [selectedText, setSelectedText] = useState("");
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editAction, setEditAction] = useState("Expand");
  const [editInstructions, setEditInstructions] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [isGeneratingSuggestions, setIsGeneratingSuggestions] = useState(false);

  const [isImageModalOpen, setIsImageModalOpen] = useState(false);
  const [imagePrompt, setImagePrompt] = useState("");
  const [activeImagePageIndex, setActiveImagePageIndex] = useState<number | null>(null);
  const [globalPrompt, setGlobalPrompt] = useState("");
  const [activeEditPageIndex, setActiveEditPageIndex] = useState<number | null>(null);
  const [isSectionEditModalOpen, setIsSectionEditModalOpen] = useState(false);
  const [sectionEditInstructions, setSectionEditInstructions] = useState("");
  const [isDownloadModalOpen, setIsDownloadModalOpen] = useState(false);
  const [isExportingPdf, setIsExportingPdf] = useState(false);
  const [projectGenerated, setProjectGenerated] = useState(false);
  const previewRef = useRef<HTMLDivElement>(null);

  const fetchSuggestions = useCallback(async () => {
    if (!selectedText) return;
    setIsGeneratingSuggestions(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
      const prompt = `You are an AI assistant helping a student edit their project document.
The user has selected the following text from their document:
"${selectedText}"

Document Context:
${(referenceText || output).substring(0, 5000)}

Generate 4-6 helpful suggestion options for how to improve or edit the selected text.

Suggestions should:
- Be simple and actionable (e.g., "Expand on the financial impact", "Add more examples of X")
- Focus on common improvements (expand, clarity, examples, etc.)
- Match the context of the document

Return suggestions in short bullet format (using a dash "-" for each bullet). Do not include any introductory or concluding text.`;
      
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
      });
      
      const text = response.text || "";
      const parsedSuggestions = text.split('\n')
        .filter(line => line.trim().startsWith('-'))
        .map(line => line.replace(/^-/, '').trim());
        
      setSuggestions(parsedSuggestions);
    } catch (err) {
      console.error("Failed to fetch suggestions:", err);
    } finally {
      setIsGeneratingSuggestions(false);
    }
  }, [selectedText, referenceText, output]);

  useEffect(() => {
    if (isEditModalOpen && selectedText && suggestions.length === 0 && !isGeneratingSuggestions) {
      fetchSuggestions();
    } else if (!isEditModalOpen && suggestions.length > 0) {
      setSuggestions([]);
    }
  }, [isEditModalOpen, selectedText, fetchSuggestions, suggestions.length, isGeneratingSuggestions]);

  useEffect(() => {
    const handleMouseUp = (e: MouseEvent) => {
      // If clicking inside the edit modal, do nothing
      if ((e.target as Element).closest('.ai-edit-modal')) return;
      
      const sel = window.getSelection();
      const text = sel?.toString().trim();
      
      if (text && text.length > 0 && step === 3) {
        const range = sel?.getRangeAt(0);
        const rect = range?.getBoundingClientRect();
        if (rect) {
          setSelectionRect({
            top: rect.top + window.scrollY - 45,
            left: rect.left + window.scrollX + (rect.width / 2),
          });
          if (text !== selectedText) {
            setSelectedText(text);
          }
        }
      } else {
        // Only clear if we're not clicking the floating button
        if (!(e.target as Element).closest('.ai-edit-button')) {
          setSelectionRect(null);
          if (!isEditModalOpen && selectedText !== "") {
            setSelectedText("");
          }
        }
      }
    };

    document.addEventListener('mouseup', handleMouseUp);
    return () => document.removeEventListener('mouseup', handleMouseUp);
  }, [step, isEditModalOpen, selectedText]);

  const renderedPages = useMemo(() => {
    if (!output) return [];
    return output.split('[PAGE_BREAK]').map(p => p.trim()).filter(p => p.length > 0);
  }, [output]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    if (!file.name.toLowerCase().endsWith('.docx')) {
      setError("Unsupported file type. Please upload a .docx file.");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setFileName(file.name);
    setError("");
    setLoadingStage('analyzing');
    
    const reader = new FileReader();
    reader.onload = async (event) => {
      const arrayBuffer = event.target?.result as ArrayBuffer;
      try {
        const result = await mammoth.extractRawText({ arrayBuffer });
        if (!result.value || result.value.trim() === '') {
          setError("The document appears to be empty or could not be read properly.");
          setLoadingStage('idle');
          return;
        }
        setReferenceText(result.value);
        await analyzeDocument(result.value);
      } catch (err) {
        console.error("Mammoth extraction error:", err);
        setError("Failed to read the DOCX file. It might be corrupted or password-protected.");
        setLoadingStage('idle');
      }
    };
    reader.onerror = () => {
      setError("A system error occurred while reading the file.");
      setLoadingStage('idle');
    };
    reader.readAsArrayBuffer(file);
    
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const analyzeDocument = async (text: string) => {
    if (!process.env.NEXT_PUBLIC_GEMINI_API_KEY) {
      setError("Gemini API key is missing.");
      setLoadingStage('idle');
      return;
    }

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
      const prompt = `${SYSTEM_PROMPT}

MODE: ANALYSIS
Extract and summarize: 
1. Heading and subheading hierarchy. 
2. Writing tone and style (e.g., formal, student-level). 
3. Paragraph length and structure. 
4. Use of examples, definitions, and case studies. 
5. Page-wise content distribution and estimated words per page.
6. Detect where visuals (images/diagrams) are used based on captions or context.

Keep the summary concise but detailed enough to use as a template for a new project.

Document Text:
${text.substring(0, 30000)} // Limit text to avoid massive token usage if doc is huge
      `;

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
      });

      setAnalysis(response.text || "Analysis complete.");
      setStep(2);
    } catch (err: any) {
      setError(err.message || "Failed to analyze document.");
    } finally {
      setLoadingStage('idle');
    }
  };

  const generateProject = async () => {
    if (!topic.trim()) {
      setError("PLEASE ENTER A TOPIC FIRST!");
      return;
    }
    if (!process.env.NEXT_PUBLIC_GEMINI_API_KEY) {
      setError("Gemini API key is missing.");
      return;
    }

    setError("");
    setLoadingStage('generating');
    setOutput("");
    setProjectGenerated(false);
    setStep(3);
    setCurrentDraftId(null);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
      
      // Limit pagesCount to prevent token overflow
      const safePagesCount = Math.min(pagesCount, 12);
      
      // Check if user wants ONLY Chapter 3
      const isChapter3Only = topic.toLowerCase().includes("chapter 3") && topic.toLowerCase().includes("only");

      const prompt = `You are an expert academic writer. ${isChapter3Only ? 'Generate ONLY Chapter 3: Research Methodology.' : `Create a completely new academic project on the topic: "${topic}".`}
      ${topicDescription.trim() ? `\nAdditional Topic Details/Elaboration:\n${topicDescription.trim()}\n` : ''}
      
      CRITICAL ACADEMIC REQUIREMENTS:
      - Follow a strict academic structure (Title Page, Table of Contents, Chapters, Meaning/Introduction, Research Methodology, Data Analysis, Conclusion, References).
      - Replace standard "Introduction" with "Meaning" where appropriate for the academic context.
      
      CHAPTER 3: RESEARCH METHODOLOGY SPECIAL RULES:
      - Section 3.1: Title MUST be "Meaning of Research Methodology" (NOT Introduction). Explain in simple, student-level language (2-3 paragraphs).
      - Section 3.2: Objectives (Primary and Secondary). Use simple, practical wording aligned with questionnaire-based study.
      - Section 3.3: Research Design. Explain Research Design properly. Include Descriptive Research and Exploratory Research with clear explanations and practical examples for each.
      - Section 3.4: Data Collection Methods. Explain Primary Data (questionnaire-based) and Secondary Data (books, websites, reports) simply and realistically.
      - Section 3.5: Sampling. Use fixed inputs: Sample Size: ${sampleSize || '113'} and Target Population: ${ageGroup || 'Age 18–25'}. REMOVE any mention of "at least one purchase".
      - Section 3.6: Research Instrument. Explain structured questionnaire, mentioning types of questions (demographic, behavior, opinion).
      - Section 3.7: Area of Study. Set location as ${area || 'Chamba'}. Write a realistic explanation about why this area was selected.
      - Section 3.8: Sampling Method. Add this as a separate section after Area of Study. Explain Convenience Sampling simply.
      - SAMPLING TECHNIQUES: Clearly explain Probability Sampling and Non-Probability Sampling. Mention that Convenience Sampling is used in this study.
      - REMOVE: Do NOT include "Limitations of Study".
      
      WRITING STYLE:
      - Use natural, student-level English. Avoid bookish or overly formal tone. Use practical words like "buy" and "sell".
      - No repetition. Maintain logical flow. Write like a real student (not AI or textbook).
      
      USER INPUT OVERRIDES:
      * Sample Size: ${sampleSize || '113'}
      * Age Group: ${ageGroup || 'Age 18–25'}
      * Area/Location: ${area || 'Chamba'}
      
      FORMATTING:
      - ${isChapter3Only ? 'Generate only the content for Chapter 3.' : `Exactly ${safePagesCount} pages long.`}
      - Academic level: ${level}.
      - Image placeholders: ${placeholders ? 'Suggest and place image positions where needed using placeholders like [Insert Research Methodology Flowchart here], [Insert Research Design Diagram here], [Insert Sampling Techniques Chart here].' : 'No images.'}
      - Base the structure, depth, formatting, and tone EXACTLY on this reference analysis:
      ${analysis}
      
      - Separate each page using exactly this delimiter on a new line: [PAGE_BREAK]
      
      Output the ${isChapter3Only ? 'Chapter 3 content' : 'full academic project'} now.`;

      const responseStream = await ai.models.generateContentStream({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: { 
          temperature: 0.7,
          maxOutputTokens: 12000 // Reduced to leave room for thinking tokens and avoid hard limit errors
        }
      });

      let finalOutput = "";
      for await (const chunk of responseStream) {
        const text = chunk.text || "";
        if (text) {
          finalOutput += text;
          setOutput((prev) => prev + text);
          setProjectGenerated(true);
        }
      }

      // Auto-save draft after generation completes
      if (user && user.uid !== 'guest' && finalOutput) {
        try {
          await addDoc(collection(db, "users", user.uid, "drafts"), {
            uid: user.uid,
            topic,
            content: finalOutput,
            pagesCount,
            level,
            sampleSize,
            ageGroup,
            area,
            placeholders,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            autoSaved: true
          });
        } catch (e) {
          console.error("Auto-save failed:", e);
        }
      }
    } catch (err: any) {
      setError(err.message || "An error occurred during generation.");
    } finally {
      setLoadingStage('idle');
    }
  };

  const modifyProject = async (type: 'simpler' | 'detailed') => {
    if (!output) return;
    setError("");
    setLoadingStage('modifying');
    const currentOutput = output;
    setOutput("");

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
      const prompt = `You are an expert academic writer. Rewrite the following project to be ${type === 'simpler' ? 'simpler, more concise, and easier to understand' : 'more detailed, expanding on the concepts, adding depth, and providing more examples'}. 
      
      CRITICAL INSTRUCTIONS:
      - Maintain the exact same number of pages.
      - You MUST use the exact delimiter [PAGE_BREAK] between pages.
      - Keep the existing image placeholders exactly as they are.
      
      Project Content:
      ${currentOutput}`;

      const responseStream = await ai.models.generateContentStream({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: { temperature: 0.7 }
      });

      for await (const chunk of responseStream) {
        const text = chunk.text || "";
        if (text) {
          setOutput((prev) => prev + text);
          setProjectGenerated(true);
        }
      }
    } catch (err: any) {
      setError(err.message || "An error occurred during modification.");
      setOutput(currentOutput); // restore on error
    } finally {
      setLoadingStage('idle');
    }
  };

  const handleGenerateImage = async () => {
    if (!imagePrompt.trim() || activeImagePageIndex === null) return;
    
    setIsImageModalOpen(false);
    setLoadingStage('generating');
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: {
          parts: [
            {
              text: imagePrompt,
            },
          ],
        },
        config: {
          imageConfig: {
            aspectRatio: "16:9",
          }
        }
      });
      
      let imageUrl = "";
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          const base64EncodeString: string = part.inlineData.data;
          imageUrl = `data:${part.inlineData.mimeType || 'image/png'};base64,${base64EncodeString}`;
          break;
        }
      }
      
      if (imageUrl) {
        const imageMarkdown = `\n\n![${imagePrompt}](${imageUrl})\n\n`;
        const newPages = [...renderedPages];
        newPages[activeImagePageIndex] += imageMarkdown;
        
        setOutput(newPages.join('\n\n[PAGE_BREAK]\n\n'));
        setProjectGenerated(true);
      } else {
        setError("Failed to generate image.");
      }
    } catch (err: any) {
      setError(err.message || "Failed to generate image.");
    } finally {
      setLoadingStage('idle');
      setImagePrompt("");
      setActiveImagePageIndex(null);
    }
  };

  const regeneratePage = async (pageIndex: number) => {
    setError("");
    setLoadingStage('regenerating_page');
    setActiveRegenerateIndex(pageIndex);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
      const pageContent = renderedPages[pageIndex];
      const prompt = `Rewrite the following page of an academic project about "${topic}". 
      Maintain the "${level}" tone. Make it sound like a real student wrote it. 
      Keep the length appropriate for a single page. Do not include the [PAGE_BREAK] delimiter in your output.
      
      Original Page Content:
      ${pageContent}`;
      
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: { temperature: 0.7 }
      });
      
      const newPageContent = response.text || "";
      const newPages = [...renderedPages];
      newPages[pageIndex] = newPageContent;
      setOutput(newPages.join('\n\n[PAGE_BREAK]\n\n'));
      setProjectGenerated(true);
    } catch (err: any) {
      setError(err.message || "Failed to regenerate page.");
    } finally {
      setLoadingStage('idle');
      setActiveRegenerateIndex(null);
    }
  };

  const editSection = async () => {
    if (!selectedText || !output) return;
    setLoadingStage('editing');
    setError("");

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
      
      const prompt = `You are an intelligent document editor working on a user-uploaded student project.

MODE: Direct Edit in Original Document

---

CORE BEHAVIOR:

- The user is editing the document directly (like a Word editor)
- The user may select or hover over a specific part (sentence, paragraph, bullet, or section)

Your job is to:
- Detect the exact selected content
- Modify ONLY that specific part
- Do NOT affect the rest of the document

---

DOCUMENT RULES:

- Preserve original structure (chapters, headings, numbering)
- Preserve formatting and flow
- Maintain student-level natural English
- Keep original meaning unless user says otherwise

---

EDITING INTELLIGENCE:

- If user selects a sentence → edit only that sentence  
- If user selects a paragraph → edit only that paragraph  
- If user selects a bullet point → edit or expand only that bullet  
- If no selection is clear → assume nearest logical section  

---

USER ACTION:

Selected Content:
${selectedText}

Instruction:
${editAction}
${editInstructions ? `\nAdditional Instructions:\n${editInstructions}` : ''}

---

TASK:

- Apply the instruction ONLY to the selected content
- Blend changes naturally with surrounding content
- Do not rewrite full section unless asked

---

OUTPUT:

Return only the updated version of the selected content  
Do NOT return full document`;

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: { temperature: 0.7 }
      });
      
      const updatedSection = response.text || "";
      
      if (output.includes(selectedText)) {
        setOutput(output.replace(selectedText, updatedSection));
        setProjectGenerated(true);
      } else {
        // Fallback: try to replace by removing extra whitespace
        const normalizedOutput = output.replace(/\s+/g, ' ');
        const normalizedSelected = selectedText.replace(/\s+/g, ' ');
        if (normalizedOutput.includes(normalizedSelected)) {
           // It's hard to replace normalized text in the original string without losing formatting.
           // So we just show an error.
           setError("Could not find the exact text in the document. Please try selecting a smaller or unformatted section.");
        } else {
           setError("Could not find the exact text in the document. Please try selecting a smaller or unformatted section.");
        }
      }
      
      setIsEditModalOpen(false);
      setSelectedText("");
      setEditInstructions("");
      setSelectionRect(null);
    } catch (err: any) {
      setError(err.message || "Failed to edit section.");
    } finally {
      setLoadingStage('idle');
    }
  };

  const handleGlobalPrompt = async () => {
    if (!globalPrompt.trim() || !output || loadingStage !== 'idle') return;
    
    setLoadingStage('modifying');
    const currentOutput = output;
    const promptText = globalPrompt;
    setGlobalPrompt("");
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
      const prompt = `You are an expert academic editor. The user wants to modify the entire project.
      
      Current Project Content:
      ${currentOutput}
      
      User Instruction: "${promptText}"
      
      CRITICAL INSTRUCTIONS:
      - Rewrite the project based on the instruction.
      - Maintain the exact same number of pages.
      - You MUST use the exact delimiter [PAGE_BREAK] between pages.
      - Maintain the academic tone and structure.
      
      Return the full updated project now.`;
      
      const responseStream = await ai.models.generateContentStream({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: { temperature: 0.7 }
      });
      
      setOutput("");
      for await (const chunk of responseStream) {
        const text = chunk.text || "";
        if (text) {
          setOutput((prev) => prev + text);
          setProjectGenerated(true);
        }
      }
    } catch (err: any) {
      setError(err.message || "Failed to apply global instruction.");
      setOutput(currentOutput);
    } finally {
      setLoadingStage('idle');
    }
  };

  const editSectionWithAI = async (pageIndex: number, instruction: string) => {
    if (!output || loadingStage !== 'idle') return;
    
    setLoadingStage('editing');
    setActiveRegenerateIndex(pageIndex);
    const currentPages = [...renderedPages];
    const sectionContent = currentPages[pageIndex];
    
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
      const prompt = `You are an expert academic editor. Rewrite ONLY this specific page of the project.
      
      Current Page Content:
      ${sectionContent}
      
      User Instruction: "${instruction}"
      
      CRITICAL INSTRUCTIONS:
      - Rewrite ONLY the content provided.
      - Maintain the same heading if it exists.
      - Keep the academic tone.
      - Do NOT add [PAGE_BREAK] or other markers.
      - Return ONLY the updated page content.`;
      
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config: { temperature: 0.7 }
      });
      
      const updatedContent = response.text || sectionContent;
      currentPages[pageIndex] = updatedContent;
      setOutput(currentPages.join('\n\n[PAGE_BREAK]\n\n'));
    } catch (err: any) {
      setError(err.message || "Failed to edit section.");
    } finally {
      setLoadingStage('idle');
      setActiveRegenerateIndex(null);
      setIsSectionEditModalOpen(false);
      setSectionEditInstructions("");
    }
  };

  const exportToDocx = async () => {
    if (!output) {
      setError("Please generate project before downloading");
      return;
    }
    try {
      setIsExporting(true);
      setError("");
      const children: any[] = [];

      for (let i = 0; i < renderedPages.length; i++) {
        const pageText = renderedPages[i];
        const lines = pageText.split('\n');
        
        for (let j = 0; j < lines.length; j++) {
          const line = lines[j];
          const isFirstLineOfPage = j === 0 && i > 0;
          
          if (line.startsWith('# ')) {
            children.push(new Paragraph({ 
              text: line.replace('# ', ''), 
              heading: HeadingLevel.HEADING_1, 
              spacing: { before: 400, after: 200 }, 
              pageBreakBefore: isFirstLineOfPage,
              alignment: AlignmentType.CENTER
            }));
          } else if (line.startsWith('## ')) {
            children.push(new Paragraph({ 
              text: line.replace('## ', ''), 
              heading: HeadingLevel.HEADING_2, 
              spacing: { before: 300, after: 150 }, 
              pageBreakBefore: isFirstLineOfPage 
            }));
          } else if (line.startsWith('### ')) {
            children.push(new Paragraph({ 
              text: line.replace('### ', ''), 
              heading: HeadingLevel.HEADING_3, 
              spacing: { before: 200, after: 100 }, 
              pageBreakBefore: isFirstLineOfPage 
            }));
          } else if (line.trim() === '') {
            children.push(new Paragraph({ text: "", pageBreakBefore: isFirstLineOfPage }));
          } else {
            const parts = line.split(/(!\[[^\]]*\]\([^)]+\))/g);
            const paragraphChildren: any[] = [];
            
            for (const part of parts) {
              const imgMatch = part.match(/!\[([^\]]*)\]\(([^)]+)\)/);
              if (imgMatch) {
                const url = imgMatch[2];
                try {
                  const response = await fetch(url);
                  if (!response.ok) throw new Error("Failed to fetch image");
                  const arrayBuffer = await response.arrayBuffer();
                  paragraphChildren.push(new ImageRun({
                    data: arrayBuffer,
                    transformation: { width: 500, height: 250 },
                    type: "jpg"
                  }));
                } catch (e) {
                  paragraphChildren.push(new TextRun({ text: part }));
                }
              } else if (part) {
                const boldParts = part.split(/(\*\*.*?\*\*)/g);
                for (const bPart of boldParts) {
                    if (bPart.startsWith('**') && bPart.endsWith('**')) {
                        paragraphChildren.push(new TextRun({ text: bPart.slice(2, -2), bold: true }));
                    } else if (bPart) {
                        paragraphChildren.push(new TextRun({ text: bPart }));
                    }
                }
              }
            }
            children.push(new Paragraph({ 
              children: paragraphChildren, 
              spacing: { after: 200, line: 360 }, // 1.5 line spacing
              pageBreakBefore: isFirstLineOfPage && paragraphChildren.length > 0 
            }));
          }
        }
      }

      const doc = new Document({
        sections: [{ 
          properties: {
            page: {
              margin: {
                top: 1440, // 1 inch
                right: 1440,
                bottom: 1440,
                left: 1440,
              }
            }
          }, 
          children: children 
        }]
      });

      const blob = await Packer.toBlob(doc);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = topic ? `${topic.replace(/\s+/g, '_')}_Project.docx` : 'ProjectCraft_Output.docx';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setIsDownloadModalOpen(false);
    } catch (err) {
      setError("Unable to download. Please try again.");
    } finally {
      setIsExporting(false);
    }
  };

  const exportToPdf = async () => {
    if (!output) {
      setError("Please generate project before downloading");
      return;
    }
    if (!previewRef.current) return;

    try {
      setIsExportingPdf(true);
      setError("");
      
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = pdf.internal.pageSize.getHeight();
      
      const pages = previewRef.current.querySelectorAll('.project-page');
      
      if (pages.length === 0) {
        throw new Error("No pages found to export.");
      }

      for (let i = 0; i < pages.length; i++) {
        const pageElement = pages[i] as HTMLElement;
        
        // Add a small delay between pages to allow memory cleanup
        await new Promise(resolve => setTimeout(resolve, 200));

        const canvas = await html2canvas(pageElement, {
          scale: 0.8, // Further reduced scale to save memory
          useCORS: true,
          logging: false,
          backgroundColor: "#ffffff",
          windowWidth: 816, // Fixed width for consistent capture
        });
        
        let imgData: string | null = canvas.toDataURL('image/jpeg', 0.6); // Increased compression
        
        if (i > 0) {
          pdf.addPage();
        }
        
        pdf.addImage(imgData, 'JPEG', 0, 0, pdfWidth, pdfHeight);
        
        // Cleanup canvas and image data memory
        imgData = null;
        canvas.width = 0;
        canvas.height = 0;
      }

      pdf.save(topic ? `${topic.replace(/\s+/g, '_')}_Project.pdf` : 'ProjectCraft_Output.pdf');
      setIsDownloadModalOpen(false);
    } catch (err) {
      console.error("PDF Export Error:", err);
      setError("Unable to download PDF. The document might be too large for your browser's memory. Try downloading as Word instead.");
    } finally {
      setIsExportingPdf(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50">
        <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 font-sans flex flex-col">
      <AnimatePresence>
        {loadingStage !== 'idle' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed top-0 left-0 right-0 h-1.5 bg-indigo-100 z-50 overflow-hidden"
          >
            <motion.div
              className="h-full bg-indigo-600"
              initial={{ x: "-100%" }}
              animate={{ x: "100%" }}
              transition={{
                repeat: Infinity,
                duration: 1.5,
                ease: "easeInOut"
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {loadingStage !== 'idle' && (
          <motion.div
            initial={{ y: 50, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 50, opacity: 0 }}
            className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-stone-900 text-white px-5 py-3 rounded-full shadow-2xl border border-stone-700"
          >
            <Loader2 className="w-5 h-5 animate-spin text-indigo-400" />
            <span className="text-sm font-medium">
              {loadingStage === 'analyzing' && "Analyzing Document..."}
              {loadingStage === 'generating' && "Generating Project..."}
              {loadingStage === 'modifying' && "Refining Document..."}
              {loadingStage === 'regenerating_page' && "Regenerating Page..."}
              {loadingStage === 'editing' && "Applying Edits..."}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      <header className="bg-white border-b border-stone-200 px-6 py-3 flex items-center justify-between sticky top-0 z-30 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="bg-indigo-600 p-2 rounded-lg shadow-sm">
            <FileText className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-stone-800">ProjectCraft AI</h1>
            <p className="text-[10px] text-stone-500 font-bold uppercase tracking-widest">Academic Engine</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button 
            onClick={() => {
              setIsDraftsModalOpen(true);
              fetchDrafts();
            }}
            className="flex items-center gap-2 text-stone-600 hover:text-indigo-600 font-bold text-[10px] uppercase tracking-tight transition-all px-3 py-2 rounded-lg hover:bg-indigo-50 cursor-pointer pointer-events-auto"
          >
            <FileSearch className="w-4 h-4" />
            My Drafts
          </button>

          <button 
            onClick={saveDraft}
            disabled={!output || isSavingDraft}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-bold text-[10px] uppercase tracking-tight transition-all border shadow-sm cursor-pointer pointer-events-auto ${
              output && !isSavingDraft
                ? "bg-white border-emerald-200 text-emerald-600 hover:bg-emerald-50" 
                : "bg-stone-50 border-stone-200 text-stone-400 cursor-not-allowed"
            }`}
          >
            {isSavingDraft ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : saveSuccess ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Save className="w-3.5 h-3.5" />}
            {isSavingDraft ? "Saving..." : saveSuccess ? "Saved!" : "Save Draft"}
          </button>

          <button 
            onClick={() => setIsDownloadModalOpen(true)}
            disabled={!projectGenerated}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-bold text-[10px] uppercase tracking-tight transition-all border shadow-sm relative z-40 cursor-pointer pointer-events-auto block ${
              projectGenerated
                ? "bg-indigo-600 border-indigo-600 text-white hover:bg-indigo-700" 
                : "bg-stone-50 border-stone-200 text-stone-400 cursor-not-allowed"
            }`}
          >
            <Download className="w-3.5 h-3.5" />
            Download
          </button>

          <div className="flex items-center gap-3 pl-4 border-l border-stone-200">
            <div className="text-right hidden md:block">
              <p className="text-xs font-bold text-stone-800 leading-none">{user.displayName}</p>
              <p className="text-[10px] text-stone-500 font-medium">{user.email}</p>
            </div>
            <div className="relative group">
              {user.photoURL ? (
                <Image src={user.photoURL} alt={user.displayName || "User"} width={32} height={32} className="rounded-full border border-stone-200 cursor-pointer" referrerPolicy="no-referrer" />
              ) : (
                <div className="w-8 h-8 bg-indigo-100 text-indigo-700 rounded-full flex items-center justify-center font-bold text-xs border border-indigo-200 cursor-pointer">
                  {user.displayName?.charAt(0) || user.email?.charAt(0) || 'U'}
                </div>
              )}
              <div className="absolute right-0 top-full mt-2 w-48 bg-white border border-stone-200 rounded-xl shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50 p-2">
                {user.uid === 'guest' ? (
                  <button 
                    onClick={handleSignIn}
                    className="w-full flex items-center gap-3 px-3 py-2 text-xs font-bold text-stone-600 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                  >
                    <LogIn className="w-4 h-4" />
                    Sign In
                  </button>
                ) : (
                  <button 
                    onClick={signOut}
                    className="w-full flex items-center gap-3 px-3 py-2 text-xs font-bold text-stone-600 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                  >
                    <LogOut className="w-4 h-4" />
                    Sign Out
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden relative">
        {/* Left Sidebar - Fixed Width */}
        <div className="w-80 border-r border-stone-200 bg-stone-50 flex flex-col shrink-0">
          <div className="flex-1 overflow-y-auto p-6 space-y-8">
            {/* Document Analysis Section */}
            <section>
              <div className="flex items-center gap-2 mb-4 text-stone-800 font-semibold">
                <FileSearch className="w-5 h-5 text-indigo-600" />
                <span>Reference Analysis</span>
              </div>
              
              {!analysis ? (
                <div 
                  onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-stone-300 rounded-xl p-6 text-center hover:border-indigo-400 hover:bg-indigo-50/30 transition-all cursor-pointer group"
                >
                  <Upload className="w-8 h-8 text-stone-400 mx-auto mb-3 group-hover:text-indigo-500 transition-colors" />
                  <p className="text-xs font-medium text-stone-600">Upload reference project</p>
                  <p className="text-[10px] text-stone-400 mt-1">DOCX files only</p>
                  <input 
                    type="file" 
                    ref={fileInputRef}
                    onChange={handleFileUpload}
                    accept=".docx"
                    className="hidden"
                  />
                </div>
              ) : (
                <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-sm">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-green-500" />
                      <span className="text-xs font-semibold text-stone-700 truncate max-w-[120px]">{fileName}</span>
                    </div>
                    <button 
                      onClick={() => {
                        setAnalysis("");
                        setFileName("");
                        setReferenceText("");
                      }}
                      className="text-[10px] text-stone-400 hover:text-red-500 font-medium"
                    >
                      Remove
                    </button>
                  </div>
                  <p className="text-[10px] text-stone-500 line-clamp-3 leading-relaxed">
                    {analysis}
                  </p>
                </div>
              )}
            </section>

            {/* Project Settings Section */}
            <section>
              <div className="flex items-center gap-2 mb-4 text-stone-800 font-semibold">
                <Settings className="w-5 h-5 text-indigo-600" />
                <span>Project Settings</span>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-stone-700 mb-1">Project Topic / Prompt</label>
                  <div className="space-y-2">
                    <input 
                      type="text" 
                      value={topic}
                      onChange={(e) => setTopic(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && generateProject()}
                      placeholder="Enter your project prompt or topic here..."
                      className="w-full text-sm border border-stone-300 rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-stone-700 mb-1">Detailed Instructions (Optional)</label>
                  <textarea 
                    value={topicDescription}
                    onChange={(e) => setTopicDescription(e.target.value)}
                    placeholder="e.g., Focus on the impact of AI in healthcare, include case studies from 2023..."
                    rows={3}
                    className="w-full text-sm border border-stone-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 resize-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-stone-700 mb-1">Pages</label>
                    <div className="flex items-center gap-2">
                      <button 
                        onClick={() => setPagesCount(Math.max(1, pagesCount - 1))}
                        className="p-1 hover:bg-stone-200 rounded"
                      >
                        <MinusCircle className="w-4 h-4 text-stone-500" />
                      </button>
                      <span className="text-sm font-medium w-6 text-center">{pagesCount}</span>
                      <button 
                        onClick={() => setPagesCount(pagesCount + 1)}
                        className="p-1 hover:bg-stone-200 rounded"
                      >
                        <PlusCircle className="w-4 h-4 text-stone-500" />
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-stone-700 mb-1">Level</label>
                    <select 
                      value={level}
                      onChange={(e) => setLevel(e.target.value)}
                      className="w-full text-xs border border-stone-300 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    >
                      <option>School</option>
                      <option>College</option>
                      <option>BBA Student</option>
                      <option>MBA Student</option>
                      <option>PhD Level</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-3 pt-2">
                  <div>
                    <label className="block text-xs font-medium text-stone-700 mb-1">Sample Size</label>
                    <input 
                      type="text" 
                      value={sampleSize}
                      onChange={(e) => setSampleSize(e.target.value)}
                      placeholder="e.g., 100 respondents"
                      className="w-full text-xs border border-stone-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-stone-700 mb-1">Age Group</label>
                    <input 
                      type="text" 
                      value={ageGroup}
                      onChange={(e) => setAgeGroup(e.target.value)}
                      placeholder="e.g., 18-25 years"
                      className="w-full text-xs border border-stone-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-stone-700 mb-1">Area / Location</label>
                    <input 
                      type="text" 
                      value={area}
                      onChange={(e) => setArea(e.target.value)}
                      placeholder="e.g., Mumbai City"
                      className="w-full text-xs border border-stone-300 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    />
                  </div>
                </div>

                <div className="flex items-center gap-2 pt-2">
                  <input 
                    type="checkbox" 
                    id="placeholders" 
                    checked={placeholders}
                    onChange={(e) => setPlaceholders(e.target.checked)}
                    className="rounded text-indigo-600 focus:ring-indigo-500"
                  />
                  <label htmlFor="placeholders" className="text-xs text-stone-600">Include image suggestions</label>
                </div>
              </div>
            </section>
          </div>

          <div className="p-4 bg-white border-t border-stone-200 shadow-[0_-4px_12px_rgba(0,0,0,0.05)]">
            <button 
              onClick={generateProject}
              disabled={!topic.trim() || loadingStage !== 'idle'}
              className="w-full border-2 border-blue-600 text-black bg-white hover:bg-blue-50 py-3.5 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition-all shadow-lg shadow-blue-100 disabled:opacity-50"
            >
              {loadingStage === 'generating' ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-blue-600" />
                  Generating...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 text-blue-600" />
                  Generate project
                </>
              )}
            </button>
          </div>
        </div>

        {/* Right Content - Output */}
        <div className="flex-1 flex flex-col bg-stone-100/50 h-[calc(100vh-73px)] overflow-hidden relative">
          {/* Toolbar */}
          <div className="h-14 bg-white border-b border-stone-200 flex items-center justify-between px-6 shrink-0 z-20 shadow-sm">
            <div className="flex items-center gap-2">
              <button 
                onClick={() => modifyProject('simpler')}
                disabled={!output || loadingStage !== 'idle'}
                className="text-xs font-bold flex items-center gap-1.5 bg-white border border-stone-200 hover:bg-stone-50 text-stone-700 px-4 py-2 rounded-lg transition-all shadow-sm disabled:opacity-50 uppercase tracking-tight"
              >
                <MinusCircle className="w-3.5 h-3.5" />
                Make Simpler
              </button>
              <button 
                onClick={() => modifyProject('detailed')}
                disabled={!output || loadingStage !== 'idle'}
                className="text-xs font-bold flex items-center gap-1.5 bg-white border border-stone-200 hover:bg-stone-50 text-stone-700 px-4 py-2 rounded-lg transition-all shadow-sm disabled:opacity-50 uppercase tracking-tight"
              >
                <PlusCircle className="w-3.5 h-3.5" />
                Make Detailed
              </button>
            </div>
          </div>

          {/* Floating Buttons - Removed as they are now in header */}
          
          {/* Scrollable Document Area */}
          <div className="flex-1 overflow-y-auto p-12 bg-stone-100/30">
            <div className="max-w-4xl mx-auto" ref={previewRef}>
              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl flex items-start gap-3 mb-8 shadow-sm">
                  <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                  <p className="text-sm font-medium">{error}</p>
                </div>
              )}

              {!output && loadingStage !== 'generating' && !error && (
                <div className="h-[60vh] flex flex-col items-center justify-center text-stone-400 space-y-8">
                  <div className="w-24 h-24 bg-white rounded-3xl shadow-xl flex items-center justify-center border border-stone-100">
                    <FileText className="w-12 h-12 text-stone-200" />
                  </div>
                  <div className="text-center space-y-3">
                    <h3 className="text-xl font-bold text-stone-700">Ready to create your project?</h3>
                    <p className="text-sm text-stone-500 max-w-xs mx-auto leading-relaxed">
                      Upload a reference document and enter your topic on the left to generate your project file.
                    </p>
                  </div>
                </div>
              )}

              {/* Render Pages */}
              <div className="space-y-12 pb-24">
                {renderedPages.map((pageContent, index) => (
                  <div key={index} className="project-page bg-white shadow-xl border border-stone-200 rounded-sm overflow-hidden relative group max-w-[816px] mx-auto mb-12 last:mb-0">
                    {/* Page Header / Toolbar */}
                    <div className="bg-stone-50 border-b border-stone-100 px-8 py-3 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className="text-[10px] font-bold text-stone-400 uppercase tracking-widest">Page {index + 1}</span>
                        <div className="h-3 w-[1px] bg-stone-200"></div>
                        <div className="flex items-center gap-2">
                          <button 
                            onClick={() => {
                              setActiveEditPageIndex(index);
                              setIsSectionEditModalOpen(true);
                            }}
                            className="text-[10px] flex items-center gap-1.5 text-stone-600 hover:text-indigo-600 font-bold uppercase tracking-tight transition-colors"
                          >
                            <Sparkles className="w-3 h-3" />
                            Edit with AI
                          </button>
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-4">
                        <div className="flex items-center gap-1">
                          <button 
                            onClick={() => editSectionWithAI(index, "Make this section simpler and more concise")}
                            className="p-1.5 text-stone-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-all"
                            title="Make Simple"
                          >
                            <MinusCircle className="w-3.5 h-3.5" />
                          </button>
                          <button 
                            onClick={() => editSectionWithAI(index, "Make this section more detailed and expand on all points")}
                            className="p-1.5 text-stone-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-all"
                            title="Make Detailed"
                          >
                            <PlusCircle className="w-3.5 h-3.5" />
                          </button>
                          <button 
                            onClick={() => editSectionWithAI(index, "Improve the language and flow of this section")}
                            className="p-1.5 text-stone-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-all"
                            title="Improve Language"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <div className="h-3 w-[1px] bg-stone-200"></div>
                        <button 
                          onClick={() => {
                            setActiveImagePageIndex(index);
                            setIsImageModalOpen(true);
                          }}
                          className="text-[10px] flex items-center gap-1.5 text-stone-600 hover:text-indigo-600 font-bold uppercase tracking-tight transition-colors"
                        >
                          <ImagePlus className="w-3.5 h-3.5" />
                          Add Image
                        </button>
                      </div>
                    </div>
                    
                    {/* Page Content */}
                    <div className="p-16 min-h-[1056px] prose prose-stone max-w-none prose-sm md:prose-base prose-headings:font-serif prose-headings:text-stone-900 prose-p:text-stone-700 prose-p:leading-relaxed">
                      {loadingStage === 'editing' && activeRegenerateIndex === index ? (
                        <div className="absolute inset-0 bg-white/60 backdrop-blur-[1px] z-10 flex flex-col items-center justify-center gap-4">
                          <div className="relative">
                            <div className="w-12 h-12 border-4 border-indigo-100 border-t-indigo-600 rounded-full animate-spin"></div>
                            <Sparkles className="w-5 h-5 text-indigo-600 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
                          </div>
                          <p className="text-sm font-bold text-indigo-600 animate-pulse uppercase tracking-widest">AI is rewriting...</p>
                        </div>
                      ) : null}
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {pageContent}
                      </ReactMarkdown>
                    </div>
                  </div>
                ))}

                <div className="flex flex-col items-center gap-4 pt-8 pb-16">
                  {user.uid === 'guest' && output && (
                    <p className="text-xs text-stone-500 font-medium italic">Sign in to save your project as a draft</p>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Global Prompt Bar */}
          {output && (
            <div className="p-4 bg-white border-t border-stone-200 shadow-[0_-10px_30px_rgba(0,0,0,0.05)] shrink-0 z-20">
              <div className="max-w-4xl mx-auto flex gap-3">
                <div className="flex-1 relative">
                  <input 
                    type="text"
                    value={globalPrompt}
                    onChange={(e) => setGlobalPrompt(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleGlobalPrompt()}
                    placeholder="Ask AI to change something in the whole project... (e.g., 'Make it more formal', 'Add a section about AI')"
                    className="w-full bg-stone-50 border border-stone-200 rounded-2xl px-5 py-4 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all shadow-inner"
                  />
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-2 pointer-events-none">
                    <span className="text-[10px] text-stone-400 font-bold bg-white px-2 py-1 rounded border border-stone-200 uppercase tracking-tighter">Enter</span>
                  </div>
                </div>
                <button 
                  onClick={handleGlobalPrompt}
                  disabled={!globalPrompt.trim() || loadingStage !== 'idle'}
                  className="bg-stone-900 hover:bg-black text-white px-8 py-4 rounded-2xl font-bold text-sm flex items-center gap-2 transition-all disabled:opacity-50 shadow-lg"
                >
                  {loadingStage === 'modifying' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4 text-indigo-400" />}
                  Apply to All (Enter)
                </button>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Section Edit Modal */}
      {isSectionEditModalOpen && (
        <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            className="bg-white rounded-3xl shadow-2xl border border-stone-200 w-full max-w-lg overflow-hidden"
          >
            <div className="px-8 py-6 border-b border-stone-100 flex items-center justify-between bg-stone-50">
              <div className="flex items-center gap-3 text-stone-800 font-bold">
                <div className="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center">
                  <Sparkles className="w-5 h-5 text-indigo-600" />
                </div>
                <div>
                  <h3 className="text-lg">Edit Page {activeEditPageIndex !== null ? activeEditPageIndex + 1 : ''}</h3>
                  <p className="text-[10px] text-stone-400 uppercase tracking-widest">AI-Powered Rewriting</p>
                </div>
              </div>
              <button 
                onClick={() => setIsSectionEditModalOpen(false)}
                className="w-8 h-8 flex items-center justify-center text-stone-400 hover:text-stone-600 hover:bg-stone-200 rounded-full transition-all"
              >
                <MinusCircle className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-8">
              <label className="block text-xs font-bold text-stone-500 uppercase tracking-widest mb-3">What should AI change on this page?</label>
              <textarea 
                value={sectionEditInstructions}
                onChange={(e) => setSectionEditInstructions(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (activeEditPageIndex !== null && sectionEditInstructions.trim() && loadingStage === 'idle') {
                      editSectionWithAI(activeEditPageIndex, sectionEditInstructions);
                    }
                  }
                }}
                placeholder="e.g., 'Expand on the research methodology', 'Make it sound more professional', 'Add a paragraph about the sample size'..."
                rows={4}
                className="w-full bg-stone-50 border border-stone-200 rounded-2xl px-5 py-4 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all shadow-inner resize-none"
                autoFocus
              />
              
              <div className="grid grid-cols-2 gap-4 mt-6">
                <button 
                  onClick={() => setIsSectionEditModalOpen(false)}
                  className="px-6 py-4 rounded-2xl font-bold text-sm text-stone-600 hover:bg-stone-100 transition-all border border-stone-200"
                >
                  Cancel
                </button>
                <button 
                  onClick={() => activeEditPageIndex !== null && editSectionWithAI(activeEditPageIndex, sectionEditInstructions)}
                  disabled={!sectionEditInstructions.trim() || loadingStage !== 'idle'}
                  className="px-6 py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-bold text-sm flex items-center justify-center gap-2 transition-all shadow-lg shadow-indigo-200 disabled:opacity-50"
                >
                  {loadingStage === 'editing' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  Rewrite Page (Enter)
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}

      {/* AI Edit Floating Button */}
      {selectionRect && selectedText && !isEditModalOpen && (
        <div 
          className="ai-edit-button absolute z-50 transform -translate-x-1/2 bg-stone-900 text-white px-3 py-1.5 rounded-lg shadow-lg flex items-center gap-2 cursor-pointer hover:bg-stone-800 transition-colors"
          style={{ top: selectionRect.top, left: selectionRect.left }}
          onMouseDown={(e) => {
            e.preventDefault(); // Prevent selection from clearing
            setIsEditModalOpen(true);
            setSelectionRect(null);
          }}
        >
          <Sparkles className="w-4 h-4 text-indigo-300" />
          <span className="text-sm font-medium">AI Edit</span>
        </div>
      )}

      {/* AI Edit Modal */}
      {isEditModalOpen && (
        <div className="ai-edit-modal fixed inset-0 bg-stone-900/20 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl border border-stone-200 w-full max-w-lg overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-stone-100 flex items-center justify-between bg-stone-50">
              <div className="flex items-center gap-2 text-stone-800 font-semibold">
                <Sparkles className="w-5 h-5 text-indigo-600" />
                <span>Edit Section</span>
              </div>
              <button 
                onClick={() => setIsEditModalOpen(false)}
                className="text-stone-400 hover:text-stone-600"
              >
                <MinusCircle className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6 flex flex-col gap-5">
              <div>
                <label className="block text-xs font-medium text-stone-500 uppercase tracking-wider mb-2">Selected Text</label>
                <div className="bg-stone-50 border border-stone-200 rounded-lg p-3 text-sm text-stone-600 max-h-32 overflow-y-auto italic">
                  &quot;{selectedText}&quot;
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-stone-500 uppercase tracking-wider mb-2">Action</label>
                <select 
                  value={editAction}
                  onChange={(e) => setEditAction(e.target.value)}
                  className="w-full bg-white border border-stone-200 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
                >
                  <option value="Expand">Expand (add explanation)</option>
                  <option value="Shorten">Shorten (reduce length)</option>
                  <option value="Add Points">Add Points (add relevant bullets)</option>
                  <option value="Rewrite">Rewrite (rephrase fully)</option>
                  <option value="Improve Quality">Improve Quality (enhance clarity)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-stone-500 uppercase tracking-wider mb-2">Additional Instructions (Optional)</label>
                <textarea 
                  value={editInstructions}
                  onChange={(e) => setEditInstructions(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if (loadingStage === 'idle') {
                        editSection();
                      }
                    }
                  }}
                  placeholder="e.g., Make it sound more professional, focus on the financial aspect..."
                  className="w-full bg-white border border-stone-200 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all resize-none h-24"
                />
                
                {isGeneratingSuggestions ? (
                  <div className="flex items-center gap-2 mt-3 text-xs text-stone-500">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Generating suggestions...
                  </div>
                ) : suggestions.length > 0 ? (
                  <div className="mt-3">
                    <p className="text-xs text-stone-500 mb-2">Suggestions:</p>
                    <div className="flex flex-wrap gap-2">
                      {suggestions.map((suggestion, idx) => (
                        <button
                          key={idx}
                          onClick={() => setEditInstructions(suggestion)}
                          className="text-left text-xs bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-100 px-3 py-1.5 rounded-full transition-colors"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="px-6 py-4 border-t border-stone-100 bg-stone-50 flex justify-end gap-3">
              <button 
                onClick={() => setIsEditModalOpen(false)}
                className="px-4 py-2 text-sm font-medium text-stone-600 hover:text-stone-800 transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={editSection}
                disabled={loadingStage !== "idle"}
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2 rounded-xl font-medium text-sm flex items-center gap-2 transition-colors disabled:opacity-50"
              >
                {loadingStage === 'editing' ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Applying...
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    Apply Changes (Enter)
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Image Generation Modal */}
      {isImageModalOpen && (
        <div className="ai-edit-modal fixed inset-0 bg-stone-900/20 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl border border-stone-200 w-full max-w-lg overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-stone-100 flex items-center justify-between bg-stone-50">
              <div className="flex items-center gap-2 text-stone-800 font-semibold">
                <ImagePlus className="w-5 h-5 text-indigo-600" />
                <span>Generate Image</span>
              </div>
              <button 
                onClick={() => setIsImageModalOpen(false)}
                className="text-stone-400 hover:text-stone-600"
              >
                <MinusCircle className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-6 flex flex-col gap-5">
              <div>
                <label className="block text-xs font-medium text-stone-500 uppercase tracking-wider mb-2">Image Prompt</label>
                <textarea 
                  value={imagePrompt}
                  onChange={(e) => setImagePrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if (imagePrompt.trim() && loadingStage === 'idle') {
                        handleGenerateImage();
                      }
                    }
                  }}
                  placeholder="e.g., A highly detailed academic chart showing market growth..."
                  className="w-full bg-white border border-stone-200 rounded-xl px-4 py-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all resize-none h-24"
                />
              </div>
            </div>

            <div className="px-6 py-4 border-t border-stone-100 bg-stone-50 flex justify-end gap-3">
              <button 
                onClick={() => setIsImageModalOpen(false)}
                className="px-4 py-2 text-sm font-medium text-stone-600 hover:text-stone-800 transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={handleGenerateImage}
                disabled={!imagePrompt.trim()}
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-5 py-2 rounded-xl font-medium text-sm flex items-center gap-2 transition-colors disabled:opacity-50"
              >
                <Sparkles className="w-4 h-4" />
                Generate & Insert (Enter)
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Download Options Modal */}
      {isDownloadModalOpen && (
        <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            className="bg-white rounded-3xl shadow-2xl border border-stone-200 w-full max-w-md overflow-hidden"
          >
            <div className="px-8 py-6 border-b border-stone-100 flex items-center justify-between bg-stone-50">
              <div className="flex items-center gap-3 text-stone-800 font-bold">
                <div className="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center">
                  <Download className="w-5 h-5 text-indigo-600" />
                </div>
                <div>
                  <h3 className="text-lg">Choose Download Format</h3>
                  <p className="text-[10px] text-stone-400 uppercase tracking-widest">Export your project</p>
                </div>
              </div>
              <button 
                onClick={() => setIsDownloadModalOpen(false)}
                className="w-8 h-8 flex items-center justify-center text-stone-400 hover:text-stone-600 hover:bg-stone-200 rounded-full transition-all"
              >
                <MinusCircle className="w-5 h-5" />
              </button>
            </div>
            
            <div className="p-8 space-y-4">
              <button 
                onClick={exportToDocx}
                disabled={isExporting}
                className="w-full flex items-center justify-between p-5 rounded-2xl border-2 border-stone-100 hover:border-indigo-600 hover:bg-indigo-50 transition-all group"
              >
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-blue-100 rounded-xl flex items-center justify-center group-hover:bg-blue-200 transition-colors">
                    <FileText className="w-6 h-6 text-blue-600" />
                  </div>
                  <div className="text-left">
                    <p className="font-bold text-stone-800">Download as Word (.docx)</p>
                    <p className="text-xs text-stone-500">Best for further editing and formatting</p>
                  </div>
                </div>
                {isExporting ? <Loader2 className="w-5 h-5 animate-spin text-indigo-600" /> : <ArrowRight className="w-5 h-5 text-stone-300 group-hover:text-indigo-600 transition-colors" />}
              </button>

              <button 
                onClick={exportToPdf}
                disabled={isExportingPdf}
                className="w-full flex items-center justify-between p-5 rounded-2xl border-2 border-stone-100 hover:border-indigo-600 hover:bg-indigo-50 transition-all group"
              >
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-red-100 rounded-xl flex items-center justify-center group-hover:bg-red-200 transition-colors">
                    <FileDown className="w-6 h-6 text-red-600" />
                  </div>
                  <div className="text-left">
                    <p className="font-bold text-stone-800">Download as PDF (.pdf)</p>
                    <p className="text-xs text-stone-500">Best for sharing and printing</p>
                  </div>
                </div>
                {isExportingPdf ? <Loader2 className="w-5 h-5 animate-spin text-indigo-600" /> : <ArrowRight className="w-5 h-5 text-stone-300 group-hover:text-indigo-600 transition-colors" />}
              </button>
            </div>
            
            <div className="px-8 py-4 bg-stone-50 border-t border-stone-100 text-center">
              <p className="text-[10px] text-stone-400 font-medium">Your project will be exported with all current edits and formatting.</p>
            </div>
          </motion.div>
        </div>
      )}

      {/* My Drafts Modal */}
      {isDraftsModalOpen && (
        <div className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            className="bg-white rounded-3xl shadow-2xl border border-stone-200 w-full max-w-2xl overflow-hidden flex flex-col max-h-[80vh]"
          >
            <div className="px-8 py-6 border-b border-stone-100 flex items-center justify-between bg-stone-50">
              <div className="flex items-center gap-3 text-stone-800 font-bold">
                <div className="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center">
                  <FileSearch className="w-5 h-5 text-indigo-600" />
                </div>
                <div>
                  <h3 className="text-lg">My Saved Drafts</h3>
                  <p className="text-[10px] text-stone-400 uppercase tracking-widest">Manage your projects</p>
                </div>
              </div>
              <button 
                onClick={() => setIsDraftsModalOpen(false)}
                className="w-8 h-8 flex items-center justify-center text-stone-400 hover:text-stone-600 hover:bg-stone-200 rounded-full transition-all"
              >
                <MinusCircle className="w-5 h-5" />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-8">
              {isLoadingDrafts ? (
                <div className="h-40 flex flex-col items-center justify-center gap-3 text-stone-400">
                  <Loader2 className="w-8 h-8 animate-spin" />
                  <p className="text-sm font-medium">Loading your drafts...</p>
                </div>
              ) : user.uid === 'guest' ? (
                <div className="h-40 flex flex-col items-center justify-center gap-3 text-stone-400">
                  <LogIn className="w-12 h-12 opacity-20" />
                  <p className="text-sm font-medium">Sign in to save and view your drafts.</p>
                  <button 
                    onClick={() => {
                      setIsDraftsModalOpen(false);
                      handleSignIn();
                    }}
                    className="mt-2 px-4 py-2 bg-indigo-50 text-indigo-600 rounded-lg text-xs font-bold hover:bg-indigo-100 transition-colors"
                  >
                    Sign In Now
                  </button>
                </div>
              ) : drafts.length === 0 ? (
                <div className="h-40 flex flex-col items-center justify-center gap-3 text-stone-400">
                  <FileText className="w-12 h-12 opacity-20" />
                  <p className="text-sm font-medium">No drafts found. Save your first project!</p>
                </div>
              ) : (
                <div className="grid gap-4">
                  {drafts.map((draft) => (
                    <div 
                      key={draft.id}
                      className="group p-5 rounded-2xl border-2 border-stone-100 hover:border-indigo-600 hover:bg-indigo-50/30 transition-all flex items-center justify-between"
                    >
                      <div className="flex-1 min-w-0 pr-4">
                        <h4 className="font-bold text-stone-800 truncate">{draft.topic}</h4>
                        <div className="flex items-center gap-3 mt-1">
                          <span className="text-[10px] font-bold text-stone-400 uppercase tracking-widest">{draft.level}</span>
                          <div className="w-1 h-1 bg-stone-300 rounded-full"></div>
                          <span className="text-[10px] font-bold text-stone-400 uppercase tracking-widest">
                            {draft.updatedAt?.toDate ? draft.updatedAt.toDate().toLocaleDateString() : 'Recently'}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button 
                          onClick={() => loadDraft(draft)}
                          className="bg-white border border-stone-200 hover:border-indigo-600 hover:text-indigo-600 text-stone-600 px-4 py-2 rounded-lg text-xs font-bold transition-all shadow-sm"
                        >
                          Load Draft
                        </button>
                        <button 
                          onClick={() => deleteDraft(draft.id)}
                          className="p-2 text-stone-300 hover:text-red-600 hover:bg-red-50 rounded-lg transition-all"
                          title="Delete Draft"
                        >
                          <MinusCircle className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            
            <div className="px-8 py-4 bg-stone-50 border-t border-stone-100 text-center">
              <p className="text-[10px] text-stone-400 font-medium">Drafts are saved securely to your account.</p>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}

"use client";

import { useState, useRef, useMemo } from "react";
import { GoogleGenAI } from "@google/genai";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Loader2, FileText, Sparkles, AlertCircle, Upload, Download, Settings, CheckCircle2, RefreshCw, MinusCircle, PlusCircle, FileSearch, ArrowRight, LogOut } from "lucide-react";
import * as mammoth from "mammoth";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun } from "docx";
import { useAuth } from "../components/AuthProvider";
import Image from "next/image";

export default function Page() {
  const { user, loading, signInWithGoogle, signOut } = useAuth();
  const [loginError, setLoginError] = useState("");
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [referenceText, setReferenceText] = useState("");
  const [analysis, setAnalysis] = useState("");
  
  const handleSignIn = async () => {
    setLoginError("");
    try {
      await signInWithGoogle();
    } catch (error: any) {
      if (error?.code === 'auth/popup-blocked') {
        setLoginError("Sign-in popup was blocked by your browser. Please allow popups for this site and try again.");
      } else {
        setLoginError("An error occurred during sign-in. Please try again.");
      }
    }
  };
  
  // Form State
  const [topic, setTopic] = useState("");
  const [topicDescription, setTopicDescription] = useState("");
  const [pagesCount, setPagesCount] = useState(10);
  const [level, setLevel] = useState("BBA Student");
  const [placeholders, setPlaceholders] = useState(true);
  
  // Output State
  const [output, setOutput] = useState("");
  const [loadingState, setLoadingState] = useState<'idle' | 'analyzing' | 'generating' | 'modifying' | 'regenerating_page'>('idle');
  const [activeRegenerateIndex, setActiveRegenerateIndex] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [fileName, setFileName] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    setLoadingState('analyzing');
    
    const reader = new FileReader();
    reader.onload = async (event) => {
      const arrayBuffer = event.target?.result as ArrayBuffer;
      try {
        const result = await mammoth.extractRawText({ arrayBuffer });
        if (!result.value || result.value.trim() === '') {
          setError("The document appears to be empty or could not be read properly.");
          setLoadingState('idle');
          return;
        }
        setReferenceText(result.value);
        await analyzeDocument(result.value);
      } catch (err) {
        console.error("Mammoth extraction error:", err);
        setError("Failed to read the DOCX file. It might be corrupted or password-protected.");
        setLoadingState('idle');
      }
    };
    reader.onerror = () => {
      setError("A system error occurred while reading the file.");
      setLoadingState('idle');
    };
    reader.readAsArrayBuffer(file);
    
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const analyzeDocument = async (text: string) => {
    if (!process.env.NEXT_PUBLIC_GEMINI_API_KEY) {
      setError("Gemini API key is missing.");
      setLoadingState('idle');
      return;
    }

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
      const prompt = `Analyze the following academic document. Extract and summarize: 
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
        model: "gemini-3.1-pro-preview",
        contents: prompt,
      });

      setAnalysis(response.text || "Analysis complete.");
      setStep(2);
    } catch (err: any) {
      setError(err.message || "Failed to analyze document.");
    } finally {
      setLoadingState('idle');
    }
  };

  const generateProject = async () => {
    if (!topic.trim()) {
      setError("Please enter a topic.");
      return;
    }
    if (!process.env.NEXT_PUBLIC_GEMINI_API_KEY) {
      setError("Gemini API key is missing.");
      return;
    }

    setError("");
    setLoadingState('generating');
    setOutput("");
    setStep(3);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.NEXT_PUBLIC_GEMINI_API_KEY });
      const prompt = `You are an expert academic writer. Create a completely new project on the topic: "${topic}".
      ${topicDescription.trim() ? `\nAdditional Topic Details/Elaboration:\n${topicDescription.trim()}\n` : ''}
      Requirements:
      - Exactly ${pagesCount} pages long.
      - Academic level: ${level}.
      - Image placeholders: ${placeholders ? 'Yes. You MUST include similar pictures, charts, or diagrams wherever they appeared in the original document. To insert an image, use this EXACT markdown format: ![Description](https://image.pollinations.ai/prompt/highly%20detailed%20description%20of%20academic%20chart%20or%20picture?width=800&height=400&nologo=true) Replace the URL path with a highly detailed, URL-encoded description of the image you want to generate.' : 'No images.'}
      - Base the structure, depth, formatting, and tone EXACTLY on this reference analysis:
      ${analysis}
      
      - Write in a natural, human-like student tone. Avoid robotic AI language.
      - Include a Title Page, Table of Contents, Main Content, Conclusion, and References.
      - Separate each page using exactly this delimiter on a new line: [PAGE_BREAK]
      
      Output the full project now.`;

      const responseStream = await ai.models.generateContentStream({
        model: "gemini-3.1-pro-preview",
        contents: prompt,
        config: { temperature: 0.7 }
      });

      for await (const chunk of responseStream) {
        setOutput((prev) => prev + (chunk.text || ""));
      }
    } catch (err: any) {
      setError(err.message || "An error occurred during generation.");
    } finally {
      setLoadingState('idle');
    }
  };

  const modifyProject = async (type: 'simpler' | 'detailed') => {
    if (!output) return;
    setError("");
    setLoadingState('modifying');
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
        model: "gemini-3.1-pro-preview",
        contents: prompt,
        config: { temperature: 0.7 }
      });

      for await (const chunk of responseStream) {
        setOutput((prev) => prev + (chunk.text || ""));
      }
    } catch (err: any) {
      setError(err.message || "An error occurred during modification.");
      setOutput(currentOutput); // restore on error
    } finally {
      setLoadingState('idle');
    }
  };

  const regeneratePage = async (pageIndex: number) => {
    setError("");
    setLoadingState('regenerating_page');
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
        model: "gemini-3.1-pro-preview",
        contents: prompt,
        config: { temperature: 0.7 }
      });
      
      const newPageContent = response.text || "";
      const newPages = [...renderedPages];
      newPages[pageIndex] = newPageContent;
      setOutput(newPages.join('\n\n[PAGE_BREAK]\n\n'));
    } catch (err: any) {
      setError(err.message || "Failed to regenerate page.");
    } finally {
      setLoadingState('idle');
      setActiveRegenerateIndex(null);
    }
  };

  const exportToDocx = async () => {
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
            children.push(new Paragraph({ text: line.replace('# ', ''), heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 }, pageBreakBefore: isFirstLineOfPage }));
          } else if (line.startsWith('## ')) {
            children.push(new Paragraph({ text: line.replace('## ', ''), heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 }, pageBreakBefore: isFirstLineOfPage }));
          } else if (line.startsWith('### ')) {
            children.push(new Paragraph({ text: line.replace('### ', ''), heading: HeadingLevel.HEADING_3, spacing: { before: 240, after: 120 }, pageBreakBefore: isFirstLineOfPage }));
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
            children.push(new Paragraph({ children: paragraphChildren, spacing: { after: 120 }, pageBreakBefore: isFirstLineOfPage && paragraphChildren.length > 0 }));
          }
        }
      }

      const doc = new Document({
        sections: [{ properties: {}, children: children }]
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
    } catch (err) {
      setError("Failed to generate DOCX file.");
    } finally {
      setIsExporting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50">
        <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50 p-6">
        <div className="bg-white border border-stone-200 rounded-2xl p-8 max-w-md w-full shadow-sm text-center">
          <div className="w-16 h-16 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <FileText className="w-8 h-8 text-indigo-600" />
          </div>
          <h1 className="text-2xl font-bold text-stone-800 mb-2">ProjectCraft AI</h1>
          <p className="text-sm text-stone-600 mb-8">
            Sign in to recreate and analyze academic projects with AI.
          </p>
          
          {loginError && (
            <div className="mb-6 p-4 bg-red-50 text-red-700 rounded-lg text-sm flex items-start gap-3 text-left">
              <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <p>{loginError}</p>
            </div>
          )}

          <button
            onClick={handleSignIn}
            className="w-full bg-white border border-stone-300 hover:bg-stone-50 text-stone-700 px-4 py-3 rounded-xl font-medium text-sm flex items-center justify-center gap-3 transition-colors shadow-sm"
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              <path d="M1 1h22v22H1z" fill="none" />
            </svg>
            Continue with Google
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 font-sans flex flex-col">
      <header className="bg-white border-b border-stone-200 px-6 py-4 flex items-center justify-between sticky top-0 z-20 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="bg-indigo-600 p-2 rounded-lg shadow-sm">
            <FileText className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-stone-800">ProjectCraft AI</h1>
            <p className="text-xs text-stone-500 font-medium">Academic Project Recreation Engine</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3 pr-4 border-r border-stone-200">
            <div className="text-right hidden sm:block">
              <p className="text-sm font-medium text-stone-800">{user.displayName}</p>
              <p className="text-xs text-stone-500">{user.email}</p>
            </div>
            {user.photoURL ? (
              <Image src={user.photoURL} alt={user.displayName || "User"} width={36} height={36} className="rounded-full border border-stone-200" referrerPolicy="no-referrer" />
            ) : (
              <div className="w-9 h-9 bg-indigo-100 text-indigo-700 rounded-full flex items-center justify-center font-bold text-sm border border-indigo-200">
                {user.displayName?.charAt(0) || user.email?.charAt(0) || 'U'}
              </div>
            )}
          </div>
          <button 
            onClick={signOut}
            className="text-stone-500 hover:text-stone-800 transition-colors p-2 rounded-lg hover:bg-stone-100"
            title="Sign Out"
          >
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        {/* Left Sidebar - Controls */}
        <div className="w-96 bg-white border-r border-stone-200 flex flex-col h-[calc(100vh-73px)] overflow-y-auto">
          <div className="p-6 space-y-8">
            
            {/* Step 1: Upload */}
            <section>
              <div className="flex items-center gap-2 mb-4">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${step >= 1 ? 'bg-indigo-600 text-white' : 'bg-stone-200 text-stone-500'}`}>1</div>
                <h2 className="text-sm font-semibold text-stone-800">Document Analysis</h2>
              </div>
              
              {!analysis && loadingState !== 'analyzing' && (
                <div 
                  onClick={() => fileInputRef.current?.click()}
                  className="border-2 border-dashed border-stone-300 rounded-xl p-6 text-center hover:bg-stone-50 hover:border-indigo-400 transition-colors cursor-pointer group"
                >
                  <FileSearch className="w-8 h-8 text-stone-400 mx-auto mb-3 group-hover:text-indigo-500" />
                  <p className="text-sm font-medium text-stone-700">Upload Reference Document</p>
                  <p className="text-xs text-stone-500 mt-1">DOCX format only</p>
                  <input type="file" accept=".docx" className="hidden" ref={fileInputRef} onChange={handleFileUpload} />
                </div>
              )}

              {loadingState === 'analyzing' && (
                <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-6 text-center">
                  <Loader2 className="w-6 h-6 text-indigo-600 animate-spin mx-auto mb-2" />
                  <p className="text-sm font-medium text-indigo-800">Analyzing Document Structure...</p>
                  <p className="text-xs text-indigo-600/70 mt-1">Extracting tone, hierarchy, and flow</p>
                </div>
              )}

              {analysis && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    <span className="text-sm font-semibold text-emerald-800">Analysis Complete</span>
                  </div>
                  <p className="text-xs text-emerald-700 line-clamp-3 leading-relaxed">{analysis}</p>
                </div>
              )}
            </section>

            {/* Step 2: Configuration */}
            <section className={step < 2 ? 'opacity-50 pointer-events-none' : ''}>
              <div className="flex items-center gap-2 mb-4">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${step >= 2 ? 'bg-indigo-600 text-white' : 'bg-stone-200 text-stone-500'}`}>2</div>
                <h2 className="text-sm font-semibold text-stone-800">Project Settings</h2>
              </div>
              
              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-stone-700 mb-1">New Topic</label>
                  <input 
                    type="text" 
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    placeholder="e.g., Digital Marketing Trends"
                    className="w-full text-sm border border-stone-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-stone-700 mb-1">Topic Description / Elaboration (Optional)</label>
                  <textarea 
                    value={topicDescription}
                    onChange={(e) => setTopicDescription(e.target.value)}
                    placeholder="Provide specific details, angles, or points you want covered..."
                    rows={3}
                    className="w-full text-sm border border-stone-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 resize-none"
                  />
                </div>
                
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-stone-700 mb-1">Total Pages</label>
                    <input 
                      type="number" 
                      value={pagesCount}
                      onChange={(e) => setPagesCount(Number(e.target.value))}
                      min={1}
                      max={50}
                      className="w-full text-sm border border-stone-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-stone-700 mb-1">Academic Level</label>
                    <input 
                      type="text" 
                      value={level}
                      onChange={(e) => setLevel(e.target.value)}
                      className="w-full text-sm border border-stone-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between bg-stone-50 border border-stone-200 p-3 rounded-lg">
                  <div>
                    <p className="text-sm font-medium text-stone-800">Image Placeholders</p>
                    <p className="text-xs text-stone-500">Auto-generate contextual images</p>
                  </div>
                  <button 
                    onClick={() => setPlaceholders(!placeholders)}
                    className={`w-10 h-5 rounded-full relative transition-colors ${placeholders ? 'bg-indigo-600' : 'bg-stone-300'}`}
                  >
                    <div className={`w-3.5 h-3.5 bg-white rounded-full absolute top-0.5 transition-transform ${placeholders ? 'translate-x-5' : 'translate-x-1'}`} />
                  </button>
                </div>

                <button
                  onClick={generateProject}
                  disabled={loadingState !== 'idle' || !topic.trim()}
                  className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-stone-300 disabled:cursor-not-allowed text-white px-4 py-3 rounded-xl font-medium text-sm flex items-center justify-center gap-2 transition-colors shadow-sm mt-4"
                >
                  {loadingState === 'generating' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  {loadingState === 'generating' ? "Generating Project..." : "Generate Project"}
                </button>
              </div>
            </section>
          </div>
        </div>

        {/* Right Content - Output */}
        <div className="flex-1 flex flex-col bg-stone-100/50 h-[calc(100vh-73px)] overflow-hidden relative">
          {/* Toolbar */}
          <div className="h-14 bg-white border-b border-stone-200 flex items-center justify-between px-6 shrink-0">
            <div className="flex items-center gap-2">
              <button 
                onClick={() => modifyProject('simpler')}
                disabled={!output || loadingState !== 'idle'}
                className="text-xs flex items-center gap-1.5 bg-white border border-stone-200 hover:bg-stone-50 text-stone-700 px-3 py-1.5 rounded-md transition-colors shadow-sm disabled:opacity-50"
              >
                <MinusCircle className="w-3.5 h-3.5" />
                Make Simpler
              </button>
              <button 
                onClick={() => modifyProject('detailed')}
                disabled={!output || loadingState !== 'idle'}
                className="text-xs flex items-center gap-1.5 bg-white border border-stone-200 hover:bg-stone-50 text-stone-700 px-3 py-1.5 rounded-md transition-colors shadow-sm disabled:opacity-50"
              >
                <PlusCircle className="w-3.5 h-3.5" />
                Make Detailed
              </button>
            </div>
            
            <button 
              onClick={exportToDocx}
              disabled={!output || loadingState !== 'idle' || isExporting}
              className="text-xs flex items-center gap-1.5 bg-indigo-50 border border-indigo-200 hover:bg-indigo-100 text-indigo-700 px-3 py-1.5 rounded-md transition-colors shadow-sm disabled:opacity-50"
            >
              {isExporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
              {isExporting ? "Exporting..." : "Download DOCX"}
            </button>
          </div>

          {/* Scrollable Document Area */}
          <div className="flex-1 overflow-y-auto p-8">
            <div className="max-w-4xl mx-auto">
              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 p-4 rounded-xl flex items-start gap-3 mb-6">
                  <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                  <p className="text-sm">{error}</p>
                </div>
              )}

              {!output && loadingState !== 'generating' && !error && (
                <div className="h-64 flex flex-col items-center justify-center text-stone-400 space-y-4">
                  <div className="w-16 h-16 bg-stone-100 rounded-full flex items-center justify-center">
                    <ArrowRight className="w-8 h-8 text-stone-300" />
                  </div>
                  <p className="text-sm text-center max-w-xs">
                    Upload a reference document and configure your project on the left to begin.
                  </p>
                </div>
              )}

              {/* Render Pages */}
              <div className="space-y-8 pb-12">
                {renderedPages.map((pageContent, index) => (
                  <div key={index} className="bg-white shadow-sm border border-stone-200 rounded-xl overflow-hidden relative group">
                    {/* Page Header */}
                    <div className="bg-stone-50 border-b border-stone-100 px-6 py-2 flex items-center justify-between">
                      <span className="text-xs font-medium text-stone-500 uppercase tracking-wider">Page {index + 1}</span>
                      <button 
                        onClick={() => regeneratePage(index)}
                        disabled={loadingState !== 'idle'}
                        className="text-xs flex items-center gap-1.5 text-indigo-600 hover:text-indigo-700 opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50"
                      >
                        {loadingState === 'regenerating_page' && activeRegenerateIndex === index ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="w-3.5 h-3.5" />
                        )}
                        Regenerate Page
                      </button>
                    </div>
                    
                    {/* Page Content */}
                    <div className="p-10 prose prose-sm md:prose-base prose-stone max-w-none prose-headings:font-semibold prose-a:text-indigo-600">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {pageContent}
                      </ReactMarkdown>
                    </div>
                  </div>
                ))}
                
                {loadingState === 'generating' && (
                  <div className="bg-white shadow-sm border border-stone-200 rounded-xl p-10 flex items-center justify-center">
                    <div className="flex items-center gap-3 text-indigo-600">
                      <Loader2 className="w-5 h-5 animate-spin" />
                      <span className="text-sm font-medium">Generating content...</span>
                    </div>
                  </div>
                )}
                
                {loadingState === 'modifying' && (
                  <div className="fixed inset-0 bg-white/50 backdrop-blur-sm z-50 flex items-center justify-center">
                    <div className="bg-white shadow-xl border border-stone-200 rounded-2xl p-6 flex flex-col items-center gap-4">
                      <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
                      <span className="text-sm font-medium text-stone-800">Refining document...</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

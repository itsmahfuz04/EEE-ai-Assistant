
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { 
  ConnectionStatus, 
  Message 
} from './types';
import { 
  MODEL_NAME, 
  SYSTEM_INSTRUCTION, 
  VOICE_NAME 
} from './constants';
import { 
  decode, 
  decodeAudioData, 
  createPcmBlob 
} from './audio-utils';

// Icons
const MicIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>
);

const StopIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/></svg>
);

const WaveIcon = ({ active }: { active: boolean }) => (
  <div className="flex items-end gap-0.5 h-6">
    {[1, 2, 3, 4, 5].map((i) => (
      <div
        key={i}
        className={`w-1 bg-blue-400 rounded-full transition-all duration-300 ${active ? 'animate-bounce' : 'h-1'}`}
        style={{ 
          height: active ? `${Math.random() * 100}%` : '4px',
          animationDelay: `${i * 0.1}s`,
          animationDuration: '0.6s'
        }}
      />
    ))}
  </div>
);

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentInputText, setCurrentInputText] = useState('');
  const [currentOutputText, setCurrentOutputText] = useState('');

  // Refs for audio processing
  const audioContextRef = useRef<AudioContext | null>(null);
  const outAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);

  const addMessage = useCallback((role: 'user' | 'model', text: string) => {
    if (!text.trim()) return;
    setMessages(prev => [
      ...prev,
      {
        id: Math.random().toString(36).substring(7),
        role,
        text,
        timestamp: Date.now()
      }
    ]);
  }, []);

  const handleMessage = useCallback(async (message: LiveServerMessage) => {
    // 1. Handle Transcription
    if (message.serverContent?.outputTranscription) {
      setCurrentOutputText(prev => prev + message.serverContent!.outputTranscription!.text);
    } else if (message.serverContent?.inputTranscription) {
      setCurrentInputText(prev => prev + message.serverContent!.inputTranscription!.text);
    }

    if (message.serverContent?.turnComplete) {
      // Logic for when a turn is finished: commit transcription to chat history
      setMessages(prev => {
        const newMessages = [...prev];
        // We capture values from the refs/state carefully
        // But for simplicity in this voice-only focused app, we just log and reset
        return newMessages;
      });
      // In a more complex app, we'd add these to messages state. 
      // For now, we'll use turnComplete as a cue to maybe reset the buffers if needed.
    }

    // 2. Handle Audio Output
    const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
    if (base64Audio && outAudioContextRef.current) {
      const ctx = outAudioContextRef.current;
      nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
      
      try {
        const audioBuffer = await decodeAudioData(
          decode(base64Audio),
          ctx,
          24000,
          1
        );
        
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);
        
        source.addEventListener('ended', () => {
          activeSourcesRef.current.delete(source);
        });

        source.start(nextStartTimeRef.current);
        nextStartTimeRef.current += audioBuffer.duration;
        activeSourcesRef.current.add(source);
      } catch (err) {
        console.error('Error playing audio chunk:', err);
      }
    }

    // 3. Handle Interruptions
    if (message.serverContent?.interrupted) {
      activeSourcesRef.current.forEach(source => {
        try { source.stop(); } catch(e) {}
      });
      activeSourcesRef.current.clear();
      nextStartTimeRef.current = 0;
    }
  }, []);

  const startSession = async () => {
    if (status !== ConnectionStatus.DISCONNECTED) return;

    setStatus(ConnectionStatus.CONNECTING);
    try {
      const apiKey = process.env.API_KEY;
      if (!apiKey) throw new Error("API Key not found");

      const ai = new GoogleGenAI({ apiKey });
      
      // Setup Audio Contexts
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            
            // Start streaming microphone
            const source = audioContextRef.current!.createMediaStreamSource(stream);
            const scriptProcessor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current = scriptProcessor;

            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              sessionPromise.then(session => {
                session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextRef.current!.destination);
          },
          onmessage: (msg) => handleMessage(msg),
          onerror: (e) => {
            console.error('Live API Error:', e);
            setStatus(ConnectionStatus.ERROR);
          },
          onclose: () => {
            stopSession();
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION,
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } }
          },
          outputAudioTranscription: {},
          inputAudioTranscription: {}
        }
      });

      sessionPromiseRef.current = sessionPromise;

    } catch (err) {
      console.error('Failed to start session:', err);
      setStatus(ConnectionStatus.ERROR);
    }
  };

  const stopSession = useCallback(() => {
    setStatus(ConnectionStatus.DISCONNECTED);
    
    // Close stream
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => track.stop());
      micStreamRef.current = null;
    }

    // Stop script processor
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }

    // Close contexts
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (outAudioContextRef.current) {
      outAudioContextRef.current.close();
      outAudioContextRef.current = null;
    }

    // Reset session
    sessionPromiseRef.current = null;
    setCurrentInputText('');
    setCurrentOutputText('');
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => stopSession();
  }, [stopSession]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-[#0f172a] text-slate-100 overflow-hidden">
      {/* Background decoration */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none z-0">
        <div className="absolute -top-[10%] -left-[10%] w-[40%] h-[40%] bg-blue-900/20 blur-[120px] rounded-full"></div>
        <div className="absolute -bottom-[10%] -right-[10%] w-[40%] h-[40%] bg-emerald-900/20 blur-[120px] rounded-full"></div>
      </div>

      <main className="relative z-10 w-full max-w-2xl flex flex-col gap-8 items-center">
        {/* Header */}
        <header className="text-center space-y-2">
          <h1 className="text-5xl font-extrabold tracking-tight bg-gradient-to-r from-blue-400 to-emerald-400 bg-clip-text text-transparent">
            Profx
          </h1>
          <p className="text-slate-400 text-lg font-medium">
            Your EEE Specialist AI Assistant
          </p>
        </header>

        {/* Visualizer / Avatar Area */}
        <div className="relative group">
          <div className={`w-64 h-64 rounded-full border-2 flex items-center justify-center transition-all duration-500 bg-slate-800/50 backdrop-blur-xl ${
            status === ConnectionStatus.CONNECTED 
              ? 'border-emerald-500/50 shadow-[0_0_50px_rgba(16,185,129,0.2)]' 
              : status === ConnectionStatus.CONNECTING 
                ? 'border-blue-500/50 animate-pulse'
                : 'border-slate-700 shadow-xl'
          }`}>
            <div className="flex flex-col items-center gap-4">
              <div className={`p-6 rounded-full transition-colors ${
                status === ConnectionStatus.CONNECTED ? 'bg-emerald-500/10' : 'bg-slate-700/50'
              }`}>
                {status === ConnectionStatus.CONNECTED ? (
                  <div className="flex gap-1 items-end h-12">
                    {[...Array(8)].map((_, i) => (
                      <div 
                        key={i} 
                        className="w-1.5 bg-emerald-400 rounded-full animate-bounce"
                        style={{ 
                          height: `${Math.random() * 80 + 20}%`,
                          animationDelay: `${i * 0.1}s`
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <MicIcon />
                )}
              </div>
              <span className="text-sm font-semibold tracking-wider uppercase opacity-60">
                {status.toLowerCase()}
              </span>
            </div>
          </div>
        </div>

        {/* Live Transcription Display */}
        <div className="w-full h-32 flex flex-col gap-2">
          {status === ConnectionStatus.CONNECTED && (
            <div className="bg-slate-800/40 border border-slate-700/50 p-4 rounded-2xl backdrop-blur-md overflow-y-auto flex flex-col gap-3 scrollbar-hide">
              {currentInputText && (
                <div className="text-sm">
                  <span className="text-blue-400 font-bold mr-2">You:</span>
                  <span className="text-slate-300 italic">"{currentInputText}"</span>
                </div>
              )}
              {currentOutputText && (
                <div className="text-sm">
                  <span className="text-emerald-400 font-bold mr-2">Profx:</span>
                  <span className="text-slate-200">{currentOutputText}</span>
                </div>
              )}
              {!currentInputText && !currentOutputText && (
                <p className="text-slate-500 text-center italic text-sm py-4">
                  Listening for your EEE queries...
                </p>
              )}
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="flex flex-col items-center gap-6 w-full">
          <button
            onClick={status === ConnectionStatus.CONNECTED ? stopSession : startSession}
            disabled={status === ConnectionStatus.CONNECTING}
            className={`
              relative flex items-center gap-3 px-8 py-4 rounded-full font-bold text-lg transition-all active:scale-95
              ${status === ConnectionStatus.CONNECTED 
                ? 'bg-rose-500 hover:bg-rose-600 text-white shadow-lg shadow-rose-900/20' 
                : 'bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/20 disabled:bg-slate-700'}
            `}
          >
            {status === ConnectionStatus.CONNECTED ? (
              <>
                <StopIcon />
                <span>End Session</span>
              </>
            ) : status === ConnectionStatus.CONNECTING ? (
              <>
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                <span>Establishing Link...</span>
              </>
            ) : (
              <>
                <MicIcon />
                <span>Start Conversation</span>
              </>
            )}
          </button>

          <p className="text-slate-500 text-xs max-w-xs text-center leading-relaxed">
            Speak to Profx about circuit analysis, power systems, or any engineering topic. Support for English and Bengali.
          </p>
        </div>

        {/* Info Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full mt-8">
          <div className="bg-slate-800/30 p-4 rounded-xl border border-slate-700/30 backdrop-blur-sm">
            <h3 className="text-xs font-bold text-blue-400 uppercase tracking-widest mb-1">Expertise</h3>
            <p className="text-sm text-slate-400">Deep technical knowledge in KVL/KCL, Power Systems, and Electronics.</p>
          </div>
          <div className="bg-slate-800/30 p-4 rounded-xl border border-slate-700/30 backdrop-blur-sm">
            <h3 className="text-xs font-bold text-emerald-400 uppercase tracking-widest mb-1">Real-time Voice</h3>
            <p className="text-sm text-slate-400">Powered by Gemini 2.5 Live API for low-latency natural conversation.</p>
          </div>
        </div>
      </main>

      {/* Footer Branding */}
      <footer className="mt-12 text-slate-600 text-[10px] tracking-[0.2em] uppercase font-bold">
        Engineered with Gemini 2.5 Flash
      </footer>
    </div>
  );
};

export default App;

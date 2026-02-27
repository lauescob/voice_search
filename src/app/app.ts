import { Component, NgZone, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-root',
  imports: [FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnInit {
  query = '';
  isListening = false;
  message = 'Presiona el micrófono y empieza a hablar.';
  platformWarning = '';
  diagnostics = {
    permissionState: 'desconocido',
    microphoneCount: 0,
    selectedMicrophone: 'No detectado',
    lastRecognitionError: '-',
    lastPermissionError: '-'
  };
  isDiagnosing = false;
  lastDiagnosticsAt = '-';
  private recognitionCtor?: new () => VoiceRecognition;
  private activeRecognition?: VoiceRecognition;
  private recognizedInCurrentSession = false;
  private hadRecognitionError = false;

  constructor(private readonly ngZone: NgZone) {
    this.initSpeechRecognition();
  }

  ngOnInit(): void {
    this.platformWarning = this.getPlatformWarning();
    void this.onDiagnoseClick();
  }

  async onDiagnoseClick(): Promise<void> {
    this.isDiagnosing = true;
    await this.refreshDiagnostics();
    this.lastDiagnosticsAt = new Date().toLocaleTimeString();
    this.message = 'Diagnóstico actualizado.';
    this.isDiagnosing = false;
  }

  async startListening(): Promise<void> {
    if (!this.recognitionCtor) {
      this.message = 'Tu navegador no soporta reconocimiento de voz.';
      return;
    }

    if (this.isListening) {
      return;
    }

    const hasPermission = await this.ensureMicrophonePermission();
    if (!hasPermission) {
      return;
    }

    this.activeRecognition = this.createRecognitionInstance();
    this.recognizedInCurrentSession = false;
    this.hadRecognitionError = false;
    this.message = 'Escuchando...';

    try {
      this.activeRecognition.start();
    } catch {
      this.activeRecognition = this.createRecognitionInstance();
      try {
        this.activeRecognition.start();
      } catch {
        this.isListening = false;
        this.activeRecognition = undefined;
        this.message = 'No pude iniciar el micrófono. Intenta nuevamente.';
      }
    }
  }

  stopListening(): void {
    this.activeRecognition?.stop();
    this.isListening = false;
  }

  runSearch(): void {
    const normalizedQuery = this.query.trim();
    this.query = normalizedQuery;

    this.message = normalizedQuery
      ? `Buscando: "${normalizedQuery}"`
      : 'Escribe o dicta algo para buscar.';
  }

  get isVoiceSupported(): boolean {
    return !!this.recognitionCtor;
  }

  private getPlatformWarning(): string {
    const iosVersion = this.getIosVersion();
    if (!iosVersion) {
      return '';
    }

    if (iosVersion < 14.5) {
      return 'iOS menor a 14.5: el reconocimiento por voz no está soportado de forma confiable.';
    }

    return 'iOS 14.5 o superior: el reconocimiento por voz puede funcionar con soporte parcial según navegador y permisos.';
  }

  private getIosVersion(): number | null {
    const userAgent = navigator.userAgent || '';
    const isIphoneOrIpad = /iPhone|iPad|iPod/i.test(userAgent);
    const isIpadOsDesktopMode =
      /Macintosh/i.test(userAgent) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1;

    if (!isIphoneOrIpad && !isIpadOsDesktopMode) {
      return null;
    }

    const versionMatch = /OS (\d+)(?:_(\d+))?/i.exec(userAgent);
    if (!versionMatch) {
      return null;
    }

    const major = Number(versionMatch[1]);
    const minor = Number(versionMatch[2] ?? '0');

    if (Number.isNaN(major) || Number.isNaN(minor)) {
      return null;
    }

    return major + minor / 10;
  }

  private initSpeechRecognition(): void {
    const SpeechRecognitionCtor =
      globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      return;
    }

    this.recognitionCtor = SpeechRecognitionCtor;
  }

  private createRecognitionInstance(): VoiceRecognition {
    if (!this.recognitionCtor) {
      throw new Error('Speech recognition no disponible');
    }

    const recognition = new this.recognitionCtor();
    recognition.lang = 'es-ES';
    recognition.interimResults = true;
    recognition.continuous = false;

    recognition.onstart = () => {
      this.ngZone.run(() => {
        this.isListening = true;
        this.recognizedInCurrentSession = false;
        this.message = 'Escuchando...';
      });
    };

    recognition.onresult = (event: VoiceRecognitionEvent) => {
      this.ngZone.run(() => {
        let transcript = '';

        const results = Array.from(
          { length: event.results.length },
          (_, index) => event.results[index]
        );

        for (const result of results) {
          transcript += `${result[0].transcript} `;
        }

        this.query = transcript.trim().replace(/\.+$/, '');
        this.recognizedInCurrentSession = !!this.query;
        this.hadRecognitionError = false;
      });
    };

    recognition.onerror = (event: VoiceRecognitionErrorEvent) => {
      this.ngZone.run(() => {
        this.isListening = false;
        this.activeRecognition = undefined;
        this.hadRecognitionError = true;
        this.diagnostics.lastRecognitionError = event.error;

        if (event.error === 'no-speech') {
          this.message = 'No detecté voz. Intenta nuevamente. (no-speech)';
          return;
        }

        if (event.error === 'audio-capture') {
          this.message =
            'No se pudo capturar audio del micrófono. Revisa el dispositivo activo en Windows/navegador. (audio-capture)';
          return;
        }

        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          this.message =
            'Permiso de micrófono bloqueado por navegador o sistema. Habilítalo e intenta otra vez.';
          return;
        }

        this.message = `Error de reconocimiento: ${event.error}`;
      });
    };

    recognition.onend = () => {
      this.ngZone.run(() => {
        this.isListening = false;
        this.activeRecognition = undefined;

        if (this.hadRecognitionError) {
          return;
        }

        if (this.recognizedInCurrentSession && this.query.trim()) {
          this.runSearch();
          return;
        }

        this.message = 'No detecté voz. Intenta nuevamente.';
      });
    };

    return recognition;
  }

  private async ensureMicrophonePermission(): Promise<boolean> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.message = 'Este navegador no soporta acceso al micrófono.';
      return false;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) {
        track.stop();
      }
      this.diagnostics.lastPermissionError = '-';
      await this.refreshDiagnostics();
      return true;
    } catch {
      this.diagnostics.lastPermissionError = 'getUserMedia bloqueado';
      this.message =
        'Permiso de micrófono bloqueado por navegador o sistema. Habilítalo e intenta otra vez.';
      await this.refreshDiagnostics();
      return false;
    }
  }

  async refreshDiagnostics(): Promise<void> {
    let permissionState = 'desconocido';

    try {
      if (navigator.permissions?.query) {
        const status = await navigator.permissions.query({
          name: 'microphone' as PermissionName
        });
        permissionState = status.state;
      }
    } catch {
      permissionState = 'no-disponible';
    }

    let selectedMicrophone = 'No detectado';
    let microphoneCount = 0;

    try {
      if (navigator.mediaDevices?.enumerateDevices) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const microphones = devices.filter((device) => device.kind === 'audioinput');
        microphoneCount = microphones.length;
        if (microphones.length > 0) {
          selectedMicrophone = microphones[0].label || 'Micrófono sin nombre (sin permiso activo)';
        }
      }
    } catch {
      selectedMicrophone = 'No fue posible leer dispositivos';
    }

    this.diagnostics = {
      ...this.diagnostics,
      permissionState,
      microphoneCount,
      selectedMicrophone
    };
  }
}

declare global {
  var SpeechRecognition: (new () => VoiceRecognition) | undefined;
  var webkitSpeechRecognition: (new () => VoiceRecognition) | undefined;
}

interface VoiceRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: VoiceRecognitionEvent) => void) | null;
  onerror: ((event: VoiceRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

interface VoiceRecognitionErrorEvent {
  error: string;
}

interface VoiceRecognitionEvent {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: {
      [index: number]: {
        transcript: string;
      };
    };
  };
}

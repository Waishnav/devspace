export type ServiceManagerKind =
  | "systemd-user"
  | "launchd"
  | "windows-task-scheduler"
  | "wsl-task-scheduler-fallback"
  | "unsupported";

export interface ServiceResult {
  ok: boolean;
  manager: ServiceManagerKind;
  message: string;
}

export interface ServiceStatus {
  installed: boolean;
  enabled: boolean;
  running: boolean;
  manager: ServiceManagerKind;
  serviceName: string;
  logPath?: string;
  endpoint?: string;
  publicBaseUrl?: string;
  pid?: number;
  details?: Record<string, unknown>;
}

export interface ServiceDoctorResult {
  manager: ServiceManagerKind;
  checks: Array<{
    level: "pass" | "warn" | "info";
    message: string;
  }>;
}

export interface ServiceManager {
  readonly kind: ServiceManagerKind;
  readonly serviceName: string;

  isSupported(): Promise<boolean>;
  remove(): Promise<ServiceResult>;
  disable(): Promise<ServiceResult>;
  start(): Promise<ServiceResult>;
  stop(): Promise<ServiceResult>;
  restart(): Promise<ServiceResult>;
  status(): Promise<ServiceStatus>;
  logs(options?: { tail?: number }): Promise<string>;
  doctor(): Promise<ServiceDoctorResult>;
}

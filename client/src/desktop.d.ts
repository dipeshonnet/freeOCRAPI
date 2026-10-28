export {};
declare global {
  const __SERVER_PORT__: string;
}
declare global {
  interface Window {
    freeocrapi?: {
      session: () => Promise<string>;
      openDashboard: () => Promise<void>;
      copyKey: () => Promise<void>;
    };
  }
}

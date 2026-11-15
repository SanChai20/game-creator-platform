// Types for hall.js (plain JS so it can use the materials kit as it ships to games).
export interface Exhibit {
  title: string; by: string; cover: string | null; color: string; rarityLabel: string; foil: number;
  ratingLabel: string; playsLabel: string; priceLabel: string; paid: boolean; art: [string, string];
}
export interface Hall {
  readonly focus: number;
  stats: { fps: number; ms: number; dpr: number; bloom: boolean; tier: string };
  focusOn(i: number): void; next(): void; prev(): void; setActive(on: boolean): void; dispose(): void;
}
export function createHall(canvas: HTMLCanvasElement, o: {
  exhibits: Exhibit[]; tier: 'full' | 'lite' | 'still'; start?: number; forced?: boolean;
  onProgress?: (p: number) => void; onFocus?: (i: number) => void; onOpen?: (i: number) => void; onFail?: () => void;
}): Promise<Hall | null>;

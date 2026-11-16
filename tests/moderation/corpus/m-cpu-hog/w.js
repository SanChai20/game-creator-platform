let n = 0; for (;;) { for (let i = 0; i < 5e7; i++) n = (n * 31 + i) >>> 0; postMessage(n); }

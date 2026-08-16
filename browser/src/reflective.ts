// Reflective UI: a blurred live front-camera feed painted behind every glass
// surface so the existing backdrop-filter chrome refracts the user's real
// environment, the way Jordan Singer's SwiftUI demo masks a camera layer with
// the navigation view. We get it almost for free because the whole app already
// renders on translucent `.glass` surfaces over `body.liquid-bg` — swapping the
// opaque color-blob backdrop for a camera layer is all it takes.
//
// Opt-in and device-local (localStorage), because a permanently-on camera is
// intrusive. Intended for iOS standalone but works anywhere getUserMedia does,
// so it can be previewed in a desktop browser before it ships to the phone.

const KEY = "reflective-ui";

let videoEl: HTMLVideoElement | null = null;
let stream: MediaStream | null = null;

export function reflectiveSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

export function isReflectiveOn(): boolean {
  return localStorage.getItem(KEY) === "1";
}

async function startCamera(): Promise<void> {
  if (stream) return;
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  if (!videoEl) {
    videoEl = document.createElement("video");
    videoEl.id = "reflective-cam";
    videoEl.autoplay = true;
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.setAttribute("playsinline", "");
    // Behind everything, ignore input. Lives directly on body so it sits in the
    // same stacking context as the .liquid-bg blob layer.
    document.body.appendChild(videoEl);
  }
  videoEl.srcObject = stream;
  await videoEl.play().catch(() => {});
}

function stopCamera(): void {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  if (videoEl) {
    videoEl.srcObject = null;
    videoEl.remove();
    videoEl = null;
  }
}

// Toggle the effect. Returns true on success; throws if the camera permission
// is denied so the caller can surface the reason.
export async function applyReflective(on: boolean): Promise<void> {
  if (on) {
    await startCamera();
    document.documentElement.classList.add("reflective");
    localStorage.setItem(KEY, "1");
  } else {
    document.documentElement.classList.remove("reflective");
    stopCamera();
    localStorage.setItem(KEY, "0");
  }
}

// Restore the effect at boot if it was on. The camera may need a user gesture
// (or a previously-granted permission) to start; if it can't, leave the effect
// off rather than crashing — the Settings toggle re-enables it with a gesture.
export function bootReflective(): void {
  if (!isReflectiveOn()) return;
  applyReflective(true).catch(() => {
    document.documentElement.classList.remove("reflective");
  });
}

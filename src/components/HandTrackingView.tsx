import { useEffect, useRef, useState } from "react";

export interface HandTrackingViewProps {
  enabled: boolean;
  onEnter?: () => void;
  onExit?: () => void;
  // Called with normalized coordinates (0..1) of the index fingertip in selfie space
  onFingerMove?: (normX: number, normY: number) => void;
  // Called when a pinch (thumb-index) gesture is detected (debounced)
  onPinch?: () => void;
  // Rich data callback for calibration/mapping
  onHandData?: (data: {
    indexTip: { x: number; y: number } | null;
    indexMCP: { x: number; y: number } | null; // landmark 5
    wrist: { x: number; y: number } | null;    // landmark 0
    palmCenter: { x: number; y: number } | null; // avg of wrist + MCPs
    isPinch: boolean;
  }) => void;
}

// Lightweight camera + MediaPipe Hands visualization component.
// Shows a mirrored webcam preview with landmark overlay when enabled.
// Does not emit cursor or hit events yet; strictly visualization.
const HandTrackingView = ({ enabled, onEnter, onExit, onFingerMove, onPinch, onHandData }: HandTrackingViewProps) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cameraControllerRef = useRef<any>(null);
  const handsRef = useRef<any>(null);
  // Keep latest callbacks without re-running the main effect
  const onEnterRef = useRef<typeof onEnter | undefined>(onEnter);
  const onExitRef = useRef<typeof onExit | undefined>(onExit);
  const onFingerMoveRef = useRef<typeof onFingerMove | undefined>(onFingerMove);
  const onPinchRef = useRef<typeof onPinch | undefined>(onPinch);
  const onHandDataRef = useRef<typeof onHandData | undefined>(onHandData);
  const lastPinchAtRef = useRef<number>(0);
  const pinchActiveRef = useRef<boolean>(false);

  useEffect(() => {
    onEnterRef.current = onEnter;
  }, [onEnter]);

  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

  useEffect(() => {
    onFingerMoveRef.current = onFingerMove;
  }, [onFingerMove]);

  useEffect(() => {
    onPinchRef.current = onPinch;
  }, [onPinch]);

  useEffect(() => {
    onHandDataRef.current = onHandData;
  }, [onHandData]);

  useEffect(() => {
    let isCancelled = false;

    const start = async () => {
      if (!enabled || !videoRef.current) return;
      setError(null);
      setLoading(true);

      try {
        const [{ Hands, HAND_CONNECTIONS }, drawingUtils, cameraUtils] = await Promise.all([
          import("@mediapipe/hands"),
          import("@mediapipe/drawing_utils"),
          import("@mediapipe/camera_utils"),
        ]);

        if (isCancelled) return;

        const video = videoRef.current;
        const canvas = canvasRef.current!;
        const ctx = canvas.getContext("2d")!;

        // Initialize Hands
        const hands = new Hands({
          locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
        });
        hands.setOptions({
          maxNumHands: 1,
          modelComplexity: 1,
          minDetectionConfidence: 0.7,
          minTrackingConfidence: 0.5,
        });
        handsRef.current = hands;

        const isPinching = (landmarks: any[]) => {
          // Use distance between thumb tip (4) and index tip (8) normalized by palm width (5-17)
          const thumbTip = landmarks[4];
          const indexTip = landmarks[8];
          const indexMCP = landmarks[5];
          const pinkyMCP = landmarks[17];
          const palmWidth = Math.hypot(indexMCP.x - pinkyMCP.x, indexMCP.y - pinkyMCP.y);
          const tipDist = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y);
          if (palmWidth === 0) return false;
          // Threshold tuned for stability; smaller means stricter
          return tipDist < palmWidth * 0.45;
        };

        hands.onResults((results: any) => {
          // Resize canvas to video size
          const w = video.videoWidth || 640;
          const h = video.videoHeight || 480;
          if (canvas.width !== w) canvas.width = w;
          if (canvas.height !== h) canvas.height = h;

          // Draw the video frame first
          ctx.save();
          // Mirror drawing to match selfie view
          ctx.clearRect(0, 0, w, h);
          ctx.scale(-1, 1);
          ctx.drawImage(results.image, -w, 0, w, h);
          ctx.restore();

          // Draw landmarks
          if (results.multiHandLandmarks) {
            // Draw all hands mirrored to match the video
            for (const landmarks of results.multiHandLandmarks) {
              const mirrored = landmarks.map((p: any) => ({ ...p, x: 1 - p.x }));
              const pinched = isPinching(landmarks);
              drawingUtils.drawConnectors(ctx, mirrored, HAND_CONNECTIONS, {
                color: pinched ? "#f59e0b" : "#22c55e",
                lineWidth: 3,
              });
              drawingUtils.drawLandmarks(ctx, mirrored, {
                color: "#60a5fa",
                lineWidth: 1,
                radius: 3,
              });
            }

            // Primary hand data (first hand)
            const primary = results.multiHandLandmarks[0];
            if (primary) {
              // Emit fingertip position
              if (onFingerMoveRef.current) {
                const indexTip = primary[8];
                const mirroredX = 1 - indexTip.x;
                const y = indexTip.y;
                onFingerMoveRef.current(mirroredX, y);
              }
              // Pinch event (debounced on rising edge)
              const pinched = isPinching(primary);
              if (pinched !== pinchActiveRef.current) {
                pinchActiveRef.current = pinched;
                if (pinched) {
                  const now = performance.now();
                  if (now - lastPinchAtRef.current > 300) {
                    lastPinchAtRef.current = now;
                    onPinchRef.current?.();
                  }
                }
              }

              // Emit rich hand data for calibration consumers
              if (onHandDataRef.current) {
                const getPoint = (i: number) => ({ x: 1 - primary[i].x, y: primary[i].y });
                const wrist = getPoint(0);
                const m5 = getPoint(5);
                const m9 = getPoint(9);
                const m13 = getPoint(13);
                const m17 = getPoint(17);
                const palmCenter = {
                  x: (wrist.x + m5.x + m9.x + m13.x + m17.x) / 5,
                  y: (wrist.y + m5.y + m9.y + m13.y + m17.y) / 5,
                };
                onHandDataRef.current({
                  indexTip: getPoint(8),
                  indexMCP: m5,
                  wrist,
                  palmCenter,
                  isPinch: pinched,
                });
              }
            }
          }
        });

        // Camera utility to feed frames to Hands
        const camera = new cameraUtils.Camera(video, {
          onFrame: async () => {
            if (!handsRef.current) return;
            await handsRef.current.send({ image: video });
          },
          width: 480,
          height: 360,
        });
        cameraControllerRef.current = camera;
        await camera.start();

        if (!isCancelled) {
          setLoading(false);
          onEnterRef.current?.();
        }
      } catch (err: any) {
        console.error("HandTrackingView error:", err);
        if (!isCancelled) {
          setLoading(false);
          setError(err?.message || "Failed to start camera or MediaPipe Hands");
        }
      }
    };

    const stop = () => {
      try {
        cameraControllerRef.current?.stop?.();
      } catch {}
      cameraControllerRef.current = null;

      handsRef.current?.close?.();
      handsRef.current = null;

      onExitRef.current?.();
    };

    if (enabled) start();
    else stop();

    return () => {
      isCancelled = true;
      stop();
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div className="fixed bottom-4 right-4 z-30 w-64 rounded-lg overflow-hidden shadow-lg border border-white/20 bg-black/50 backdrop-blur-sm">
      <div className="relative w-full" style={{ aspectRatio: "4 / 3" }}>
        {/* We draw into canvas for mirrored + overlay visuals */}
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full opacity-0" // hidden; drawing on canvas
          autoPlay
          playsInline
          muted
        />
        {loading && (
          <div className="absolute inset-0 grid place-items-center text-white text-xs bg-black/40">
            Initializing hand tracking…
          </div>
        )}
        {error && (
          <div className="absolute inset-0 grid place-items-center text-red-300 text-xs bg-black/60 p-2 text-center">
            {error}
          </div>
        )}
      </div>
      <div className="px-2 py-1 text-[10px] text-white/80 bg-black/40">Hand Mode</div>
    </div>
  );
};

export default HandTrackingView;



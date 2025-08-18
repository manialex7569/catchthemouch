import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { BirdType } from "./InsectSelectScreen";
import { useConnectedUsers, useStateTogether, useStateTogetherWithPerUserValues, useMyId, useJoinUrl, useLeaveSession, useFunctionTogether } from "react-together";
import { useAccount } from "wagmi";
import { Copy, Users } from "lucide-react";
import { hitService, HitData } from "@/services/hitService";
import { saveGameData } from "@/services/gameDataService";
import { useToast } from "@/hooks/use-toast";
import { ExternalLink } from "lucide-react";
import { Toaster } from "@/components/ui/toaster";
import HandTrackingView from "./HandTrackingView";

interface SpriteData {
  image: HTMLImageElement;
  frameWidth: number;
  frameHeight: number;
  totalFrames: number;
  rows: number;
  columns: number;
  duration: number;
  loaded: boolean;
}

interface GameScreenMultiplayerProps {
  onBackToMenu: () => void;
  isHost?: boolean;
  roomId?: string;
}

interface BirdPosition {
  id: string;
  bird: BirdType;
  x: number;
  y: number;
  velocityX: number;
  velocityY: number;
  direction: 'left' | 'right';
  initialY: number;
  status: 'flying' | 'hit';
  animation?: { currentFrame: number; lastFrameTime: number };
  // Pooling + spatial hash internals
  active?: boolean;
  cellKey?: string;
}

type GameResults = {
  [gameId: number]: {
    [userId: string]: number;
  };
};

const FIXED_PASSWORD = 'catchbirds';

function getRoomIdFromJoinUrl(joinUrl: string | null): string {
  if (!joinUrl) return '';
  const match = joinUrl.match(/[?&]rtName=([^&#]+)/);
  return match ? decodeURIComponent(match[1]) : joinUrl;
}

const GameScreenMultiplayer = ({ onBackToMenu, isHost, roomId }: GameScreenMultiplayerProps) => {
  const myId = useMyId();
  const users = useConnectedUsers();
  const joinUrl = useJoinUrl();
  const leaveSession = useLeaveSession();
  const { address } = useAccount();
  const { toast } = useToast();

  // Synchronized function to force all players to leave session
  const forceEndSession = useFunctionTogether('force-end-session', useCallback(() => {
    leaveSession();
    onBackToMenu();
  }, [leaveSession, onBackToMenu]));

  const [myWalletAddress, setMyWalletAddress, allWalletAddresses] = useStateTogetherWithPerUserValues('walletAddress', '');

  useEffect(() => {
    if (address) setMyWalletAddress(address);
  }, [address, setMyWalletAddress]);

  // Shared state for multi-game logic
  const [gameStarted, setGameStarted] = useStateTogether('gameStarted', false);
  const [countdown, setCountdown] = useStateTogether('countdown', 0);
  const [seconds, setSeconds] = useStateTogether('seconds', 60);
  const [gameId, setGameId] = useStateTogether('gameId', 1);
  const [sessionLocked, setSessionLocked] = useStateTogether('sessionLocked', false);
  const [allowedUsers, setAllowedUsers] = useStateTogether<string[]>('allowedUsers', []);
  const [sessionEnded, setSessionEnded] = useStateTogether('sessionEnded', false);
  
  // New state for waiting logic (only during gameplay)
  const [waitingForPlayers, setWaitingForPlayers] = useStateTogether('waitingForPlayers', false);
  const [waitingTimer, setWaitingTimer] = useStateTogether('waitingTimer', 30);
  const [waitingReason, setWaitingReason] = useStateTogether('waitingReason', '');
  const [hostUserId, setHostUserId] = useStateTogether('hostUserId', '');

  // Set initial host
  useEffect(() => {
    if (isHost && myId && !hostUserId) {
      setHostUserId(myId);
    }
  }, [isHost, myId, hostUserId, setHostUserId]);

  // Host transfer logic
  useEffect(() => {
    if (users.length > 0 && hostUserId) {
      const currentHost = users.find(u => u.userId === hostUserId);
      if (!currentHost && users.length > 0) {
        // Host left, transfer to random user
        const randomUser = users[Math.floor(Math.random() * users.length)];
        setHostUserId(randomUser.userId);
      }
    }
  }, [users, hostUserId, setHostUserId]);

  // Check if current user is host
  const isCurrentHost = myId === hostUserId;

  // Check if current user should be allowed to join (if session is locked/ended and they're not already in)
  useEffect(() => {
    if (myId) {
      // Check if session is ended
      if (sessionEnded) {
        setIsBeingKicked(true);
        return;
      }
      
      // Check if session is locked and user is not allowed
      if (sessionLocked && allowedUsers.length > 0) {
        const isAllowed = allowedUsers.includes(myId);
        if (!isAllowed) {
          // New user trying to join locked session - show kick message
          setIsBeingKicked(true);
        }
      }
    }
  }, [sessionLocked, sessionEnded, myId, allowedUsers]);

  // Per-user scores and hits
  const [myTotalScore, setMyTotalScore, allTotalScores] = useStateTogetherWithPerUserValues('totalScore', 0);
  const [myTotalHits, setMyTotalHits, allTotalHits] = useStateTogetherWithPerUserValues('totalHits', 0);
  const [gameResults, setGameResults] = useStateTogether<GameResults>('gameResults', {});
  const [myHitHistory, setMyHitHistory] = useState<Array<{
    birdType: string;
    points: number;
    timestamp: number;
  }>>([]);

  // Floating points animation state
  const [floatingPoints, setFloatingPoints] = useState<Array<{
    id: string;
    points: number;
    x: number;
    y: number;
    opacity: number;
  }>>([]);

  // Shared hit histories for all players
  const [allHitHistories, setAllHitHistories] = useStateTogether('hitHistories', {} as Record<string, Array<{
    birdType: string;
    points: number;
    timestamp: number;
  }>>);

  // Calculate current totals from myHitHistory
  const myCurrentScore = myHitHistory.reduce((sum, hit) => sum + hit.points, 0);
  const myCurrentHits = myHitHistory.length;

  // Session management for Supabase
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [hasSavedGameData, setHasSavedGameData] = useState(false);

  // Unified animation manager refs (multiplayer version)
  const birdsRef = useRef<BirdPosition[]>([]);
  const birdPoolRef = useRef<BirdPosition[]>([]);
  const spatialHashRef = useRef<Map<string, Set<BirdPosition>>>(new Map());
  const cursorPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const cursorAnimRef = useRef<{ isHitting: boolean; hitFrame: number; hitTimer: number }>({ isHitting: false, hitFrame: 0, hitTimer: 0 });
  const floatingPointsRef = useRef<Array<{ id: string; points: number; x: number; y: number; opacity: number }>>([]);
  const spriteSheetsRef = useRef<{[key: string]: SpriteData}>({});
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const backgroundImageRef = useRef<HTMLImageElement | null>(null);
  const lastFrameTimeRef = useRef<number>(0);
  const gameLoopRef = useRef<number | null>(null);
  // No React state for birds; refs are the single source of truth
  const [gameOver, setGameOver] = useState(false);
  const [isBeingKicked, setIsBeingKicked] = useState(false);
  const [showPlayerList, setShowPlayerList] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number; isHitting: boolean; hitFrame: number; hitTimer: number }>({
    x: 0,
    y: 0,
    isHitting: false,
    hitFrame: 0,
    hitTimer: 0
  });
  const batRef = useRef<HTMLDivElement | null>(null);

  const gameContainerRef = useRef<HTMLDivElement>(null);
  const intervalRef = useRef<NodeJS.Timeout>();
  // Removed secondary RAF; single unified gameLoop handles update + render
  const spawnTimeoutRef = useRef<NodeJS.Timeout>();
  const dieAudioRef = useRef<HTMLAudioElement | null>(null);
  const gunAudioRef = useRef<HTMLAudioElement | null>(null);
  const gameoverAudioRef = useRef<HTMLAudioElement | null>(null);
  const bgMusicRef = useRef<HTMLAudioElement | null>(null);
  const countdownAudioRef = useRef<HTMLAudioElement | null>(null);
  const waitingTimerRef = useRef<NodeJS.Timeout>();

  // Hand mode state/refs
  const [handModeEnabled, setHandModeEnabled] = useState(false);
  // Direct hand coords (no smoothing for better responsiveness)
  const currentHandPosRef = useRef<{ x: number; y: number } | null>(null);

  // Responsive scaling based on game container size
  const getScaledSize = useCallback((baseSize: number) => {
    if (!gameContainerRef.current) return baseSize;
    const container = gameContainerRef.current;
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;
    
    // Use the smaller dimension to maintain proportions
    const scaleFactor = Math.min(containerWidth / 896, containerHeight / 504); // 896x504 is max-w-4xl aspect-[16/9]
    return Math.max(baseSize * scaleFactor, baseSize * 0.5); // Minimum 50% of original size
  }, []);

  const birdTypes: BirdType[] = [
    { name: "Bee", image: "/animals/bee.gif", points: 1, rarity: 'common', spawnRate: 15 },
    { name: "Butterfly", image: "/animals/butterfly.gif", points: 2, rarity: 'uncommon', spawnRate: 10 },
    { name: "Blue Mouch", image: "/animals/bluemouch.gif", points: 5, rarity: 'rare', spawnRate: 5 },
    { name: "Mouch", image: "/animals/mouch.gif", points: 10, rarity: 'legendary', spawnRate: 2 },
  ];

  const formatTime = (totalSeconds: number) => {
    const minutes = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const getRandomBird = (): BirdType => {
    const random = Math.random();
    if (random < 0.6) return birdTypes[0];
    else if (random < 0.85) return birdTypes[1];
    else if (random < 0.95) return birdTypes[2];
    else return birdTypes[3];
  };

  // --- Canvas sprites setup (align with single-player) ---
  const initializeSpriteSheets = useCallback(() => {
    const spriteSheets: Record<string, SpriteData> = {
      bee: { frameWidth: 512, frameHeight: 512, totalFrames: 4, rows: 1, columns: 4, duration: 0.4, loaded: false, image: new Image() },
      butterfly: { frameWidth: 512, frameHeight: 512, totalFrames: 2, rows: 1, columns: 2, duration: 0.2, loaded: false, image: new Image() },
      bluemouch: { frameWidth: 360, frameHeight: 360, totalFrames: 150, rows: 30, columns: 5, duration: 4.5, loaded: false, image: new Image() },
      mouch: { frameWidth: 320, frameHeight: 320, totalFrames: 126, rows: 26, columns: 5, duration: 5.04, loaded: false, image: new Image() },
      player: { frameWidth: 48, frameHeight: 180, totalFrames: 2, rows: 1, columns: 2, duration: 0.2, loaded: false, image: new Image() },
    } as any;

    Object.keys(spriteSheets).forEach((key) => {
      const sheet = spriteSheets[key];
      const img = new Image();
      img.onload = () => {
        if (key === 'player') {
          const derivedW = Math.floor(img.width / sheet.columns);
          const derivedH = Math.floor(img.height / sheet.rows);
          spriteSheetsRef.current[key] = { ...sheet, frameWidth: derivedW || sheet.frameWidth, frameHeight: derivedH || sheet.frameHeight, image: img, loaded: true };
        } else {
          spriteSheetsRef.current[key] = { ...sheet, image: img, loaded: true };
        }
      };
      img.src = key === 'player' ? '/player.png' : `/spritesheet/${key}.png`;
    });

    // Background image
    const bgImg = new Image();
    bgImg.onload = () => { backgroundImageRef.current = bgImg; };
    bgImg.src = '/background.jpg';
  }, []);

  const drawBackground = useCallback((ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => {
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, '#e0f2fe');
    gradient.addColorStop(0.5, '#bfdbfe');
    gradient.addColorStop(1, '#93c5fd');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (backgroundImageRef.current) {
      ctx.drawImage(backgroundImageRef.current, 0, 0, canvas.width, canvas.height);
      const overlay = ctx.createLinearGradient(0, 0, 0, canvas.height);
      overlay.addColorStop(0, 'rgba(186, 230, 253, 0.7)');
      overlay.addColorStop(0.5, 'rgba(147, 197, 253, 0.6)');
      overlay.addColorStop(1, 'rgba(147, 197, 253, 0.7)');
      ctx.fillStyle = overlay;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }, []);

  const drawBird = useCallback((ctx: CanvasRenderingContext2D, bird: BirdPosition) => {
    const key = bird.bird.name.toLowerCase().replace(' ', '');
    const sprite = spriteSheetsRef.current[key];
    if (!sprite || !sprite.loaded) return;
    const now = Date.now();
    const frameInterval = (sprite.duration * 1000) / sprite.totalFrames;
    if (bird.animation && now - bird.animation.lastFrameTime >= frameInterval) {
      bird.animation.currentFrame = (bird.animation.currentFrame + 1) % sprite.totalFrames;
      bird.animation.lastFrameTime = now;
    }
    const currentFrame = bird.animation ? bird.animation.currentFrame : 0;
    const frameCol = currentFrame % sprite.columns;
    const frameRow = Math.floor(currentFrame / sprite.columns);
    const sourceX = frameCol * sprite.frameWidth;
    const sourceY = frameRow * sprite.frameHeight;
    let renderSize = getScaledSize(80);
    if (bird.bird.name === 'Bee') renderSize = Math.round(renderSize * 3.8);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(bird.x, bird.y);
    if (bird.direction === 'right') ctx.scale(-1, 1);
    if (bird.status === 'hit') { ctx.scale(1, -1); ctx.rotate(0.26); }
    ctx.drawImage(sprite.image, sourceX, sourceY, sprite.frameWidth, sprite.frameHeight, -renderSize / 2, -renderSize / 2, renderSize, renderSize);
    ctx.restore();
  }, [getScaledSize]);

  const drawBatCursor = useCallback((ctx: CanvasRenderingContext2D) => {
    const sprite = spriteSheetsRef.current.player;
    if (!sprite || !sprite.loaded) return;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    const frameX = cursorAnimRef.current.isHitting ? cursorAnimRef.current.hitFrame * sprite.frameWidth : 0;
    const renderWidth = getScaledSize(48);
    const renderHeight = getScaledSize(180);
    const pos = cursorPosRef.current;
    const drawX = Math.round(pos.x - renderWidth / 2);
    const drawY = Math.round(pos.y - renderHeight / 2);
    ctx.drawImage(sprite.image, frameX, 0, sprite.frameWidth, sprite.frameHeight, drawX, drawY, renderWidth, renderHeight);
    ctx.restore();
  }, [getScaledSize]);

  const drawFloatingPoint = useCallback((ctx: CanvasRenderingContext2D, point: { id: string; points: number; x: number; y: number; opacity: number }) => {
    ctx.save();
    ctx.globalAlpha = point.opacity;
    ctx.fillStyle = '#facc15';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.lineWidth = 2;
    ctx.font = '18px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const text = `+${point.points}`;
    ctx.strokeText(text, point.x, point.y);
    ctx.fillText(text, point.x, point.y);
    ctx.restore();
  }, []);

  // --- Spatial hashing helpers ---
  const getCellKeyFromXY = useCallback((x: number, y: number, cellSize: number) => {
    const ix = Math.floor(x / cellSize);
    const iy = Math.floor(y / cellSize);
    return `${ix},${iy}`;
  }, []);

  const spatialInsert = useCallback((bird: BirdPosition, cellSize: number) => {
    const key = getCellKeyFromXY(bird.x, bird.y, cellSize);
    bird.cellKey = key;
    let bucket = spatialHashRef.current.get(key);
    if (!bucket) {
      bucket = new Set<BirdPosition>();
      spatialHashRef.current.set(key, bucket);
    }
    bucket.add(bird);
  }, [getCellKeyFromXY]);

  const spatialUpdateIfMoved = useCallback((bird: BirdPosition, cellSize: number) => {
    const nextKey = getCellKeyFromXY(bird.x, bird.y, cellSize);
    if (bird.cellKey === nextKey) return;
    if (bird.cellKey) {
      const prev = spatialHashRef.current.get(bird.cellKey);
      prev?.delete(bird);
      if (prev && prev.size === 0) spatialHashRef.current.delete(bird.cellKey);
    }
    bird.cellKey = nextKey;
    let next = spatialHashRef.current.get(nextKey);
    if (!next) {
      next = new Set<BirdPosition>();
      spatialHashRef.current.set(nextKey, next);
    }
    next.add(bird);
  }, [getCellKeyFromXY]);

  const spatialRemove = useCallback((bird: BirdPosition) => {
    if (!bird.cellKey) return;
    const bucket = spatialHashRef.current.get(bird.cellKey);
    bucket?.delete(bird);
    if (bucket && bucket.size === 0) spatialHashRef.current.delete(bird.cellKey);
    bird.cellKey = undefined;
  }, []);

  const queryNearbyBirds = useCallback((x: number, y: number, radius: number) => {
    const result: BirdPosition[] = [];
    const cellSize = Math.max(1, radius * 2);
    const ix = Math.floor(x / cellSize);
    const iy = Math.floor(y / cellSize);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const key = `${ix + dx},${iy + dy}`;
        const bucket = spatialHashRef.current.get(key);
        if (!bucket) continue;
        bucket.forEach(b => { if (b.status === 'flying') result.push(b); });
      }
    }
    return result;
  }, []);

  const gameLoop = useCallback(() => {
    if (!canvasRef.current || !ctxRef.current) return;
    const now = performance.now();
    const dt = lastFrameTimeRef.current ? (now - lastFrameTimeRef.current) / 1000 : 0;
    lastFrameTimeRef.current = now;
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawBackground(ctx, canvas);
    if (gameStarted && !gameOver && !waitingForPlayers) {
      if (cursorAnimRef.current.isHitting) {
        cursorAnimRef.current.hitTimer += dt;
        const newFrame = Math.floor(cursorAnimRef.current.hitTimer * 10);
        if (newFrame >= 2) { cursorAnimRef.current.isHitting = false; cursorAnimRef.current.hitFrame = 0; cursorAnimRef.current.hitTimer = 0; }
        else if (newFrame !== cursorAnimRef.current.hitFrame) { cursorAnimRef.current.hitFrame = newFrame; }
      }
      // --- Simulation step (movement + pooling + spatial hash updates)
      if (gameContainerRef.current) {
        const { clientWidth: width, clientHeight: height } = gameContainerRef.current;
        const hitRadius = getScaledSize(32);
        const cellSize = Math.max(1, hitRadius * 2);
        for (let i = 0; i < birdsRef.current.length;) {
          const bird = birdsRef.current[i];
          if (bird.status === 'hit') {
            const gravity = 0.1;
            bird.velocityY = bird.velocityY + gravity;
            bird.y = bird.y + bird.velocityY;
            spatialUpdateIfMoved(bird, cellSize);
            if (bird.y <= height + 100) {
              i++;
            } else {
              spatialRemove(bird);
              bird.active = false;
              birdPoolRef.current.push(bird);
              const last = birdsRef.current.pop()!;
              if (i < birdsRef.current.length) {
                birdsRef.current[i] = last;
              }
            }
          } else {
            let newX = bird.x + bird.velocityX;
            let newY = bird.y + bird.velocityY;
            if (bird.bird.name === 'Butterfly') {
              const waveFrequency = 0.03;
              const waveAmplitude = 1.2;
              newY = bird.initialY + bird.velocityY * (bird.x / bird.velocityX) + Math.sin(bird.x * waveFrequency) * waveAmplitude * 20;
            } else if (bird.bird.name === 'Bee') {
              newX += (Math.random() - 0.5) * 3;
            }
            if (newX >= -150 && newX <= width + 150 && newY >= -150 && newY <= height + 150) {
              bird.x = newX; bird.y = newY; spatialUpdateIfMoved(bird, cellSize); i++;
            } else {
              spatialRemove(bird);
              bird.active = false;
              birdPoolRef.current.push(bird);
              const last = birdsRef.current.pop()!;
              if (i < birdsRef.current.length) {
                birdsRef.current[i] = last;
              }
            }
          }
        }
      }
      // Draw birds after update
      for (let i = 0; i < birdsRef.current.length; i++) drawBird(ctx, birdsRef.current[i]);
      // Floating points: faster rise and short lifetime
      if (floatingPointsRef.current.length > 0) {
        for (let i = 0; i < floatingPointsRef.current.length; i++) { const p = floatingPointsRef.current[i]; p.y -= 350 * dt; p.opacity -= 1.6 * dt; }
        floatingPointsRef.current = floatingPointsRef.current.filter(p => p.opacity > 0);
        for (let i = 0; i < floatingPointsRef.current.length; i++) drawFloatingPoint(ctx, floatingPointsRef.current[i]);
      }
    }
    drawBatCursor(ctx);
    gameLoopRef.current = requestAnimationFrame(gameLoop);
  }, [gameStarted, gameOver, waitingForPlayers, drawBackground, drawBird, drawFloatingPoint, drawBatCursor, getScaledSize, spatialRemove, spatialUpdateIfMoved]);
  const createBird = useCallback((flockOptions?: { side: number; y: number }) => {
    if (gameOver || !gameStarted || !gameContainerRef.current) return;
    const container = gameContainerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;
    
    // Responsive spawn distance based on container size, but capped to prevent going outside
    const spawnDistance = Math.min(getScaledSize(100), Math.min(width, height) * 0.2);
    
    let x = 0, y = 0, targetX = 0, targetY = 0;
    const side = flockOptions?.side ?? Math.floor(Math.random() * 4);
    switch (side) {
      case 0: x = -spawnDistance; y = Math.max(spawnDistance, Math.min(height - spawnDistance, flockOptions?.y ?? Math.random() * height)); targetX = width + spawnDistance; targetY = Math.max(spawnDistance, Math.min(height - spawnDistance, Math.random() * height)); break;
      case 1: x = width + spawnDistance; y = Math.max(spawnDistance, Math.min(height - spawnDistance, flockOptions?.y ?? Math.random() * height)); targetX = -spawnDistance; targetY = Math.max(spawnDistance, Math.min(height - spawnDistance, Math.random() * height)); break;
      case 2: x = Math.max(spawnDistance, Math.min(width - spawnDistance, Math.random() * width)); y = -spawnDistance; targetX = Math.max(spawnDistance, Math.min(width - spawnDistance, Math.random() * width)); targetY = height + spawnDistance; break;
      case 3: x = Math.max(spawnDistance, Math.min(width - spawnDistance, Math.random() * width)); y = height + spawnDistance; targetX = Math.max(spawnDistance, Math.min(width - spawnDistance, Math.random() * width)); targetY = -spawnDistance; break;
    }
    const birdType = getRandomBird();
    const dx = targetX - x;
    const dy = targetY - y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const timeProgress = 1 - (seconds / 60);
    const baseSpeed = 1.5 + (timeProgress * 1.5);
    const speed = baseSpeed + Math.random() * 1.0;
    const velocityX = (dx / distance) * speed;
    const velocityY = (dy / distance) * speed;
    // Reuse from pool if available, else create
    const pooled = birdPoolRef.current.pop();
    const instance: BirdPosition = pooled ?? {
      id: '',
      bird: birdType,
      x: 0,
      y: 0,
      velocityX: 0,
      velocityY: 0,
      direction: 'left',
      initialY: 0,
      status: 'flying',
      animation: { currentFrame: 0, lastFrameTime: Date.now() },
      active: false,
      cellKey: undefined,
    };
    instance.id = Math.random().toString(36).substring(7);
    instance.bird = birdType;
    instance.x = x;
    instance.y = y;
    instance.velocityX = velocityX;
    instance.velocityY = velocityY;
    instance.direction = velocityX > 0 ? 'right' : 'left';
    instance.initialY = y;
    instance.status = 'flying';
    if (!instance.animation) instance.animation = { currentFrame: 0, lastFrameTime: Date.now() };
    instance.animation.currentFrame = 0;
    instance.animation.lastFrameTime = Date.now();
    instance.active = true;
    instance.cellKey = undefined;
    birdsRef.current.push(instance);
    // Insert into spatial grid using current hit cell size
    const hitRadius = getScaledSize(32);
    spatialInsert(instance, Math.max(1, hitRadius * 2));
  }, [gameOver, gameStarted, seconds, getScaledSize, spatialInsert]);

  const createFlock = useCallback(() => {
    if (gameOver || !gameStarted || !gameContainerRef.current) return;
    const container = gameContainerRef.current;
    const height = container.clientHeight;
    const flockSize = 3 + Math.floor(Math.random() * 3);
    const flockStartY = Math.random() * (height - 150) + 75;
    const side = Math.floor(Math.random() * 2);
    for (let i = 0; i < flockSize; i++) {
      const yOffset = flockStartY + (Math.random() - 0.5) * 150;
      setTimeout(() => createBird({ side, y: yOffset }), i * (100 + Math.random() * 50));
    }
  }, [createBird, gameOver, gameStarted]);

  const catchBird = useCallback(async (birdId: string) => {
    const bird = birdsRef.current.find(b => b.id === birdId);
    if (bird && bird.status === 'flying') {
      // Track individual hit for this player
      const newHit = {
        birdType: bird.bird.name,
        points: bird.bird.points,
        timestamp: Date.now()
      };
      
      setMyHitHistory(prev => [...prev, newHit]);
      
      // Add floating points animation
      const newFloatingPoint = {
        id: Math.random().toString(36).substring(7),
        points: bird.bird.points,
        x: bird.x,
        y: bird.y,
        opacity: 1
      };
      floatingPointsRef.current = [...floatingPointsRef.current, newFloatingPoint];
      
      // Share hit data with all players via react-together
      setAllHitHistories(prev => ({
        ...prev,
        [myId]: [...(prev[myId] || []), newHit]
      }));
      
      if (dieAudioRef.current) { dieAudioRef.current.currentTime = 0; dieAudioRef.current.play(); }
      if (gunAudioRef.current) { gunAudioRef.current.currentTime = 0; gunAudioRef.current.play(); }
      // Mutate in place
      bird.status = 'hit';
      bird.velocityX = 0;
      bird.velocityY = 2;

      // Record hit on blockchain if wallet is connected
      if (address) {
        try {
          const hitData: HitData = {
            player: address,
            points: bird.bird.points
          };
          // Record hit immediately for better reliability
          const result = await hitService.recordHitImmediate(hitData);
          if (result.success) {
            console.log("✅ Hit recorded on blockchain:", result.hash);
            toast({
              title: "🎯 Hit Recorded!",
              description: (
                <div className="flex flex-col gap-2">
                  {/* <span>Hit recorded on blockchain</span> */}
                  {result.hash && (
                    <a 
                      href={`https://testnet.monadexplorer.com/tx/${result.hash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-blue-500 hover:text-blue-600 text-xs"
                    >
                      View Transaction <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              ),
              variant: "success",
              duration: 3000, // 3 seconds
            });
          } else {
            console.error("❌ Failed to record hit:", result.error);
            toast({
              title: "❌ Hit Failed",
              description: `Failed to record hit on blockchain: ${result.error}`,
              variant: "destructive",
              duration: 3000,
            });
          }
        } catch (error) {
          console.error("Failed to record hit:", error);
          toast({
            title: "❌ Hit Failed",
            description: `Failed to record hit on blockchain: ${error}`,
            variant: "destructive",
            duration: 3000,
          });
        }
      }
    }
  }, [address, myId, toast]);

  // Removed separate moveBirds RAF; movement handled in unified gameLoop

  // Host: reset shared state on initial mount for a new session
  useEffect(() => {
    if (isHost) {
      setGameStarted(false);
      setCountdown(0);
      setSeconds(60);
      setGameId(1);
      setGameResults({});
      setSessionLocked(false);
      setAllowedUsers([]);
      setSessionEnded(false);
      setWaitingForPlayers(false);
      setWaitingTimer(30);
      setWaitingReason('');
      setCurrentSessionId(null); // Reset session ID for new session
    }
    // eslint-disable-next-line
  }, [isHost, roomId]);

  // Handle user count changes and waiting logic (ONLY during gameplay, not lobby or game over)
  useEffect(() => {
    const userCount = users.length;
    
    // During gameplay: if count < 2, start waiting timer
    if (gameStarted && !gameOver && userCount < 2) {
      setWaitingForPlayers(true);
      setWaitingTimer(30);
      setWaitingReason('A player left during the game. Waiting for them to rejoin...');
    }
    
    // During gameplay: if count >= 2 and was waiting, stop waiting
    if (gameStarted && !gameOver && userCount >= 2 && waitingForPlayers) {
      setWaitingForPlayers(false);
      setWaitingTimer(30);
      setWaitingReason('');
    }
    
    // At game over: if count < 2, show waiting message (no timer)
    if (gameOver && userCount < 2) {
      setWaitingForPlayers(true);
      setWaitingReason('Waiting for more players to join...');
    }
    
    // At game over: if count >= 2 and was waiting, stop waiting
    if (gameOver && userCount >= 2 && waitingForPlayers) {
      setWaitingForPlayers(false);
      setWaitingReason('');
    }
  }, [users.length, gameStarted, gameOver, waitingForPlayers]);

  // Waiting timer logic (ONLY during gameplay, not lobby or game over)
  useEffect(() => {
    if (waitingForPlayers && waitingTimer > 0 && gameStarted && !gameOver) {
      waitingTimerRef.current = setTimeout(() => {
        setWaitingTimer(prev => {
          if (prev <= 1) {
            // Timer expired, end session
            if (isCurrentHost) {
              setSessionEnded(true);
              forceEndSession();
            }
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    
    return () => {
      if (waitingTimerRef.current) {
        clearTimeout(waitingTimerRef.current);
      }
    };
  }, [waitingForPlayers, waitingTimer, gameStarted, gameOver, isCurrentHost, forceEndSession, setWaitingTimer]);

  // Host action to start the countdown for any game
  const handleStartGame = () => {
    if (isCurrentHost && users.length >= 2) {
      if (!sessionLocked) {
        setSessionLocked(true);
        // Store current users as allowed users when locking
        setAllowedUsers(users.map(u => u.userId));
      }
      setCountdown(3);
    }
  };

  // Host action to end the entire session for all players
  const handleEndSession = () => {
    if (isCurrentHost) {
      // Mark session as ended first
      setSessionEnded(true);
      // This will trigger all players to leave the session
      forceEndSession();
    }
  };

  // Host action to set up the next round (return to lobby)
  const setupNextGame = () => {
      if (isCurrentHost) {
          setGameResults(prevResults => ({
              ...prevResults,
              [gameId]: allTotalScores
          }));
          setGameId(prev => prev + 1);
          setGameOver(false);
          setGameStarted(false);
          setCountdown(0);
          setSeconds(60);
      }
  };

  // Multiplayer Supabase integration - save game data at game over
  useEffect(() => {
    if (gameOver && isCurrentHost && myHitHistory.length > 0 && address && !hasSavedGameData) {
      // Collect all players' data for this game with individual hit histories
      const allPlayersData = Object.entries(allTotalScores).map(([userId, userScore]) => ({
        playerAddress: allWalletAddresses[userId] || '',
        playerId: userId,
        finalScore: userScore,
        totalHits: allTotalHits[userId] || 0,
        hitHistory: allHitHistories[userId] || [] // ✅ Now has all players' individual hits!
      }));

      saveGameData({
        sessionType: 'multiplayer',
        hostAddress: address,
        score: myCurrentScore,
        hits: myCurrentHits,
        hitHistory: myHitHistory,
        durationSec: 60 - seconds,
        playerId: myId,
        gameNumber: gameId,
        sessionId: currentSessionId,
        allPlayersData: allPlayersData
      }).then((sessionId) => {
        console.log("✅ Multiplayer game data saved to Supabase!");
        setHasSavedGameData(true); // Prevent double saving
        if (!currentSessionId && sessionId) {
          setCurrentSessionId(sessionId);
        }
      }).catch((err) => {
        console.error("❌ Failed to save multiplayer game data:", err);
      });
    }
  }, [gameOver, isCurrentHost, myHitHistory, address, myCurrentScore, myCurrentHits, seconds, myId, gameId, currentSessionId, allTotalScores, allTotalHits, allWalletAddresses, allHitHistories, hasSavedGameData]);

  // Reset save flag when new game starts
  useEffect(() => {
    if (myId) {
        setMyHitHistory([]); // Reset hit history
        // birdsRef is authoritative; no React state mirror needed
        setGameOver(false);
        setHasSavedGameData(false); // Reset save flag for new game
        if (gameId === 1) {
            setMyTotalScore(0);
            setMyTotalHits(0);
        }
    }
  }, [gameId, myId, setMyHitHistory, setMyTotalScore, setMyTotalHits]);

  // Countdown logic (shared)
  useEffect(() => {
    if (countdown > 0 && !gameStarted) {
      if (countdownAudioRef.current) {
        countdownAudioRef.current.currentTime = 0;
        countdownAudioRef.current.play();
      }
      const timer = setTimeout(() => setCountdown(c => c - 1), 1000);
      if (countdown === 1) {
        setTimeout(() => setGameStarted(true), 1000);
      }
      return () => clearTimeout(timer);
    }
  }, [countdown, gameStarted, setCountdown, setGameStarted]);

  // Timer logic (shared)
  useEffect(() => {
    if (!gameStarted || gameOver) return;
    intervalRef.current = setInterval(() => {
      setSeconds(prev => {
        if (prev <= 1) {
          setGameOver(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [gameStarted, gameOver, setSeconds]);

  // Bird spawning and animation
  useEffect(() => {
    if (!gameStarted || gameOver || waitingForPlayers) return;
    const spawnLoop = () => {
      const spawnDelay = 250 + (seconds / 60) * 600;
      if (Math.random() < 0.15) createFlock();
      else createBird();
      spawnTimeoutRef.current = setTimeout(spawnLoop, spawnDelay);
    };
    spawnLoop();
    return () => {
      if (spawnTimeoutRef.current) clearTimeout(spawnTimeoutRef.current);
    };
  }, [gameStarted, gameOver, waitingForPlayers, seconds, createBird, createFlock]);

  // Canvas init & unified RAF like single-player
  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctxRef.current = ctx;
    const resizeCanvas = () => {
      if (!gameContainerRef.current) return;
      const rect = gameContainerRef.current.getBoundingClientRect();
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
    };
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    initializeSpriteSheets();
    return () => { window.removeEventListener('resize', resizeCanvas); };
  }, [initializeSpriteSheets]);

  useEffect(() => {
    if (!gameLoopRef.current) {
      gameLoopRef.current = requestAnimationFrame(gameLoop);
    }
    return () => {
      if (gameLoopRef.current) { cancelAnimationFrame(gameLoopRef.current); gameLoopRef.current = null; }
    };
  }, [gameLoop]);

  // Background music
  useEffect(() => {
    if (gameStarted && !gameOver && !waitingForPlayers) {
      if (bgMusicRef.current) {
        bgMusicRef.current.currentTime = 0;
        bgMusicRef.current.play();
      }
    } else {
      if (bgMusicRef.current) {
        bgMusicRef.current.pause();
        bgMusicRef.current.currentTime = 0;
      }
    }
  }, [gameStarted, gameOver, waitingForPlayers]);

  // Update total score and hits when a game ends
  const isGameOverHandled = useRef(false);
  useEffect(() => {
      if (gameOver && !isGameOverHandled.current) {
          setMyTotalScore(prev => prev + myCurrentScore);
          setMyTotalHits(prev => prev + myCurrentHits);
          isGameOverHandled.current = true;
          if (gameoverAudioRef.current) {
              gameoverAudioRef.current.currentTime = 0;
              gameoverAudioRef.current.play();
          }
      } else if (!gameOver) {
          isGameOverHandled.current = false;
      }
  }, [gameOver, myCurrentScore, myCurrentHits, setMyTotalScore, setMyTotalHits]);

  // Handle mouse movement for cursor (disabled in hand mode)
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (handModeEnabled) return;
    if (!gameContainerRef.current) return;
    const rect = gameContainerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    cursorPosRef.current = { x, y };
  }, [handModeEnabled]);

  // Direct hand position update (no RAF loop, no smoothing)
  const updateHandPosition = useCallback((palmPos: { x: number; y: number }) => {
    if (!handModeEnabled || !gameContainerRef.current) return;
    const rect = gameContainerRef.current.getBoundingClientRect();
    const targetX = palmPos.x * rect.width;
    const targetY = palmPos.y * rect.height;
    cursorPosRef.current = { x: targetX, y: targetY };
    currentHandPosRef.current = { x: targetX, y: targetY };
  }, [handModeEnabled]);

  // Cursor animation handled in unified RAF via cursorAnimRef

  // Floating points animated via RAF using floatingPointsRef

  // Handle mouse click for bat hitting animation
  const handleGameAreaClick = useCallback((e: React.MouseEvent) => {
    // Only play gun sound if game is started and not clicking on UI elements
    if (gameStarted && !gameOver) {
      if (gunAudioRef.current) {
        gunAudioRef.current.currentTime = 0;
        gunAudioRef.current.play();
      }
    }
    
    // Start hit animation
    cursorAnimRef.current.isHitting = true;
    cursorAnimRef.current.hitFrame = 0;
    cursorAnimRef.current.hitTimer = 0;

    // Check for collision with birds at click position using responsive hit radius
    if (gameContainerRef.current && gameStarted && !gameOver) {
      const rect = gameContainerRef.current.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;
      
      // Use responsive hit radius based on container size (32)
      const hitRadius = getScaledSize(32);
      const r2 = hitRadius * hitRadius;
      const candidates = queryNearbyBirds(clickX, clickY, hitRadius);
      for (let i = 0; i < candidates.length; i++) {
        const bird = candidates[i];
        const dx = clickX - bird.x;
        const dy = clickY - bird.y;
        if (dx * dx + dy * dy < r2) {
          catchBird(bird.id);
        }
      }
    }
  }, [gameStarted, gameOver, catchBird, getScaledSize, queryNearbyBirds]);

  // Copy room ID to clipboard
  const copyRoomId = async () => {
    const roomIdToShow = roomId || getRoomIdFromJoinUrl(joinUrl);
    if (roomIdToShow) {
      await navigator.clipboard.writeText(roomIdToShow);
    }
  };

  const getPlayerDisplayName = (userId: string) => {
    const userAddress = allWalletAddresses[userId];
    if (userAddress) {
      return `${userAddress.slice(0, 6)}...${userAddress.slice(-4)}`;
    }
    return `Player...${userId.slice(0, 4)}`;
  };

  const roomIdToShow = roomId || getRoomIdFromJoinUrl(joinUrl);

  // Show waiting screen during gameplay only
  if (waitingForPlayers && gameStarted && !gameOver) {
    return (
      <div className="min-h-screen w-full bg-background text-foreground font-press-start flex flex-col items-center justify-center p-8 relative">
        <div className="text-center">
          <h1 className="text-4xl mb-4 text-yellow-500">Waiting for Players</h1>
          <p className="text-xl mb-4">{waitingReason}</p>
          <div className="text-6xl font-bold text-yellow-300 mb-4">{waitingTimer}</div>
          <p className="text-lg mb-4">Players: {users.length}/2</p>
          {isCurrentHost && (
            <Button 
              onClick={handleEndSession} 
              className="mt-6 bg-red-600 text-white hover:bg-red-700 font-press-start text-lg px-8 py-4"
            >
              End Session
            </Button>
          )}
        </div>
      </div>
    );
  }

  // --- MODIFICATION: Game Over UI is now a separate, full-screen return statement ---
  if (gameOver) {
    return (
        <div className="min-h-screen w-full bg-background text-foreground font-press-start flex flex-col items-center justify-center p-8 relative select-none">
            <audio ref={gameoverAudioRef} src="/audio/gameover.mp3" preload="auto" />
            
            {/* We need to show some info here too */}
            <div className="absolute top-6 right-8 flex items-center gap-2">
                <div className="text-sm">Room ID: <span className="font-bold">{roomIdToShow}</span></div>
                            <Button onClick={copyRoomId} variant="ghost" size="icon" className="h-6 w-6 p-1">
                    <Copy className="h-4 w-4" />
                </Button>
            </div>

            <h1 className="text-4xl mb-4">Game Over!</h1>
            
            <div className="text-center mb-6">
                <h3 className="text-2xl mb-2">Scores for Game {gameId}</h3>
                {Object.entries(allTotalScores).map(([userId, userTotalScore]) => (
                    <p key={userId}>{getPlayerDisplayName(userId)}: {userTotalScore} (Hits: {allTotalHits[userId] || 0})</p>
                ))}
            </div>

            <div className="text-center">
                <h3 className="text-2xl mb-2">Total Scores</h3>
                {Object.entries(allTotalScores).map(([userId, userTotalScore]) => (
                    <p key={userId}>{getPlayerDisplayName(userId)}: {userTotalScore} (Hits: {allTotalHits[userId] || 0})</p>
                ))}
            </div>
            
            <div className="flex gap-4 justify-center mt-8">
                {users.length >= 2 ? (
                  isCurrentHost ? (
                    <Button onClick={setupNextGame} className="bg-primary text-primary-foreground hover:opacity-90 font-press-start text-lg px-8 py-4">
                        Start Another Game
                    </Button>
                  ) : (
                    <p className="text-xl text-yellow-300">Waiting for the host...</p>
                  )
                ) : (
                  <p className="text-xl text-yellow-300">Waiting for more players to join...</p>
                )}
                {isCurrentHost ? (
                  users.length >= 2 ? (
                    <div className="flex gap-4">
                      <Button onClick={() => { leaveSession(); onBackToMenu(); }} variant="outline" className="font-press-start text-lg px-8 py-4">
                        Leave Session
                      </Button>
                      <Button onClick={handleEndSession} variant="outline" className="font-press-start text-lg px-8 py-4 bg-red-600 text-white hover:bg-red-700">
                        End Session
                      </Button>
                    </div>
                  ) : (
                    <Button onClick={handleEndSession} variant="outline" className="font-press-start text-lg px-8 py-4 bg-red-600 text-white hover:bg-red-700">
                      End Session
                    </Button>
                  )
                ) : (
                  <Button onClick={() => { leaveSession(); onBackToMenu(); }} variant="outline" className="font-press-start text-lg px-8 py-4">
                    Leave Session
                  </Button>
                )}
            </div>
      </div>
    );
  }

  // Show kick message if user is being kicked out
  if (isBeingKicked) {
    return (
      <div className="min-h-screen w-full bg-background text-foreground font-press-start flex flex-col items-center justify-center p-8 relative">
        <div className="text-center">
          <h1 className="text-4xl mb-4 text-red-500">
            {sessionEnded ? "Session Ended" : "Session Locked"}
          </h1>
          <p className="text-xl mb-4">
            {sessionEnded 
              ? "This session has ended and is no longer available." 
              : "This session is locked and no new players can join."
            }
          </p>
          <Button 
            onClick={() => { leaveSession(); onBackToMenu(); }} 
            className="mt-6 bg-primary text-primary-foreground hover:opacity-90 font-press-start text-lg px-8 py-4"
          >
            Return to Main Menu
          </Button>
        </div>
      </div>
    );
  }

  return (
    // --- MODIFICATION: Added 'select-none' to prevent highlighting on fast clicks ---
    <div className="min-h-screen w-full bg-background text-foreground font-press-start flex flex-col items-center justify-between p-8 relative select-none">
      <div className="absolute left-0 top-0 w-full flex justify-between items-start px-8 pt-6 z-20">
        <div className="flex flex-col items-start">
          <div className="text-lg">Game: {gameId}</div>
          <div className="text-lg">Time: {formatTime(seconds)}</div>
          <div className="text-lg">Score: {myCurrentScore} | Hits: {myCurrentHits}</div>
        </div>

          <div className="flex flex-col items-end">
          <div className="flex items-center gap-2 mb-2">
            <div className="text-sm">Room ID: <span className="font-bold">{roomIdToShow}</span></div>
            <Button
              onClick={copyRoomId}
              variant="ghost"
              size="icon"
              className="h-6 w-6 p-1"
            >
              <Copy className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex gap-2 mb-2">
            <Button
              onClick={() => setHandModeEnabled((prev) => !prev)}
              className={`${handModeEnabled ? "bg-green-600 hover:bg-green-700" : "bg-blue-600 hover:bg-blue-700"} text-white px-4 py-2 rounded`}
            >
              {handModeEnabled ? "Hand Mode: ON" : "Hand Mode: OFF"}
            </Button>
          </div>
          {isCurrentHost ? (
            users.length >= 2 ? (
              <div className="flex gap-2">
                <Button onClick={() => { leaveSession(); onBackToMenu(); }} className="bg-red-500 text-white px-4 py-2 rounded">
                  Leave Game
                </Button>
                <Button onClick={handleEndSession} className="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700">
                  End Session
                </Button>
              </div>
            ) : (
              <Button onClick={handleEndSession} className="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700">
                End Session
              </Button>
            )
          ) : (
            <Button onClick={() => { leaveSession(); onBackToMenu(); }} className="bg-red-500 text-white px-4 py-2 rounded">
              Leave Game
            </Button>
          )}
        </div>
      </div>

      <div className="w-full max-w-4xl flex justify-center items-start mt-24 z-10">
        <div
          ref={gameContainerRef}
          className="w-full max-w-4xl aspect-[16/9] relative overflow-hidden rounded-lg border-4 border-gray-300 shadow-lg"
          style={{ cursor: 'none', position: 'relative' }}
          onMouseMove={handleMouseMove}
          onClick={handleGameAreaClick}
        >
          {/* Canvas for multiplayer rendering */}
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full"
            style={{ imageRendering: 'auto' }}
          />

          {!gameStarted && !gameOver && (
            <div className="absolute inset-0 flex items-center justify-center z-50 bg-black/20">
              <div className="flex flex-col items-center">
                {users.length < 2 ? (
                  <div className="text-center">
                    <div className="text-white text-2xl mb-4">Waiting for others to join...</div>
                  </div>
                ) : (
                  <>
                    {isCurrentHost && countdown === 0 && (
                      <Button 
                        onClick={handleStartGame} 
                        className="bg-green-500 text-white px-6 py-3 rounded mb-2 hover:bg-green-600 transition-colors duration-200 transform hover:scale-105"
                      >
                        Start Game
                      </Button>
                    )}
                    {countdown > 0 && (
                      <div className="text-6xl text-white font-bold mb-2">{countdown}</div>
                    )}
                    {!isCurrentHost && countdown === 0 && (
                      <div className="text-white text-xl">Waiting for Host to Start...</div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
       {/* Side button to show/hide player list */}
       <div className="fixed top-40 right-8 z-30">
        <Button
          onClick={() => setShowPlayerList(!showPlayerList)}
          className="bg-gradient-to-b from-indigo-500 to-blue-600 text-white hover:from-indigo-600 hover:to-blue-700 shadow-xl border-2 border-white/30 p-3 rounded-full"
          size="icon"
        >
          <Users className="h-6 w-6" />
        </Button>
      </div>

      {/* Player list panel */}
      {showPlayerList && (
        <div className="fixed top-40 right-20 w-64 flex-shrink-0 rounded-xl bg-gradient-to-b from-indigo-500 via-blue-600 to-blue-800 shadow-xl border-2 border-white/30 p-4 flex flex-col items-center h-[450px] z-30">
          <div className="text-lg font-bold text-white mb-4 tracking-wider">Players ({users.length})</div>
          <div className="flex flex-col gap-2 w-full items-center overflow-y-auto max-h-[350px] scrollbar-thin scrollbar-thumb-white/30 scrollbar-track-transparent">
            {users.map(u => {
              const shortAddress = getPlayerDisplayName(u.userId);
              return (
                <div key={u.userId} className={`text-white text-center text-sm p-2 rounded w-full ${u.isYou ? "bg-green-500/50 font-bold" : ""} ${u.userId === hostUserId ? "border-2 border-yellow-400" : ""}`}>
                  <div>{shortAddress}{u.isYou && " (you)"}{u.userId === hostUserId && " (Host)"}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      

      <audio ref={dieAudioRef} src="/audio/die.mp3" preload="auto" />
      <audio ref={gunAudioRef} src="/audio/gun.mp3" preload="auto" />
      <audio ref={bgMusicRef} src="/audio/gamemusic.mp3" preload="auto" loop />
      <audio ref={countdownAudioRef} src="/audio/Countdown.mp3" preload="auto" />
      {gameStarted && !gameOver && !waitingForPlayers && <Toaster />}
      {/* Hand tracking preview & handlers */}
      <HandTrackingView
        enabled={handModeEnabled}
        onEnter={() => console.log('Hand mode entered (multiplayer)')}
        onExit={() => console.log('Hand mode exited (multiplayer)')}
        onPinch={() => {
          // Only process hits during active game
          if (!gameStarted || gameOver || waitingForPlayers) return;
          
          // Trigger hit animation
          cursorAnimRef.current.isHitting = true;
          cursorAnimRef.current.hitFrame = 0;
          cursorAnimRef.current.hitTimer = 0;
          if (gunAudioRef.current) { gunAudioRef.current.currentTime = 0; gunAudioRef.current.play(); }
          
          // Use current real-time hand position for hit detection (same as mouse)
          if (cursorPosRef.current) {
            const hitRadius = getScaledSize(32);
            const cx = cursorPosRef.current.x;
            const cy = cursorPosRef.current.y;
            const r2 = hitRadius * hitRadius;
            const candidates = queryNearbyBirds(cx, cy, hitRadius);
            for (let i = 0; i < candidates.length; i++) {
              const bird = candidates[i];
              const dx = cx - bird.x;
              const dy = cy - bird.y;
              if (dx * dx + dy * dy < r2) { catchBird(bird.id); }
            }
          }
        }}
        onHandData={(data) => {
          if (!handModeEnabled) return;
          const source = data.palmCenter;
          if (!source) return;

          // Direct position update - no smoothing for maximum responsiveness
          const nx = Math.max(0, Math.min(1, source.x));
          const ny = Math.max(0, Math.min(1, source.y));
          
          // Update position immediately
          updateHandPosition({ x: nx, y: ny });
        }}
      />
    </div>
  );
};

export default GameScreenMultiplayer;
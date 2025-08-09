import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { BirdType } from "./InsectSelectScreen";
import { useAccount } from "wagmi";
import { hitService, HitData } from "@/services/hitService";
import { saveGameData } from "@/services/gameDataService";
import { useToast } from "@/hooks/use-toast";
import { ExternalLink } from "lucide-react";
import { Toaster } from "@/components/ui/toaster";
import HandTrackingView from "./HandTrackingView";

interface GameScreenProps {
  onBackToMenu: () => void;
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
  status: 'flying' | 'hit'; // New property to track the bird's state
}

interface CursorState {
  x: number;
  y: number;
  isHitting: boolean;
  hitFrame: number;
  hitTimer: number;
}

const GameScreen = ({ onBackToMenu }: GameScreenProps) => {
  const { address } = useAccount();
  const { toast } = useToast();
  const [seconds, setSeconds] = useState(60);
  const [birds, setBirds] = useState<BirdPosition[]>([]);
  const [gameOver, setGameOver] = useState(false);
  const [gameStarted, setGameStarted] = useState(false);
  const [countdown, setCountdown] = useState(3);
  const [cursor, setCursor] = useState<CursorState>({ x: 0, y: 0, isHitting: false, hitFrame: 0, hitTimer: 0 });
  const batRef = useRef<HTMLDivElement | null>(null);
  const [hitHistory, setHitHistory] = useState<Array<{
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

  // Hand mode toggle
  const [handModeEnabled, setHandModeEnabled] = useState(false);
  // Direct hand coords (no smoothing for better responsiveness)
  const currentHandPosRef = useRef<{ x: number; y: number } | null>(null);

  // Calculate totals from hitHistory
  const score = hitHistory.reduce((sum, hit) => sum + hit.points, 0);
  const hits = hitHistory.length;

  const gameContainerRef = useRef<HTMLDivElement>(null);
  const intervalRef = useRef<NodeJS.Timeout>();
  const animationRef = useRef<number>();
  const spawnTimeoutRef = useRef<NodeJS.Timeout>();
  const dieAudioRef = useRef<HTMLAudioElement | null>(null);
  const gunAudioRef = useRef<HTMLAudioElement | null>(null);
  const gameoverAudioRef = useRef<HTMLAudioElement | null>(null);
  const bgMusicRef = useRef<HTMLAudioElement | null>(null);
  const countdownAudioRef = useRef<HTMLAudioElement | null>(null);

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
      case 0: // Left
        x = -spawnDistance; 
        y = Math.max(spawnDistance, Math.min(height - spawnDistance, flockOptions?.y ?? Math.random() * height));
        targetX = width + spawnDistance; 
        targetY = Math.max(spawnDistance, Math.min(height - spawnDistance, Math.random() * height));
        break;
      case 1: // Right
        x = width + spawnDistance; 
        y = Math.max(spawnDistance, Math.min(height - spawnDistance, flockOptions?.y ?? Math.random() * height));
        targetX = -spawnDistance; 
        targetY = Math.max(spawnDistance, Math.min(height - spawnDistance, Math.random() * height));
        break;
      case 2: // Top
        x = Math.max(spawnDistance, Math.min(width - spawnDistance, Math.random() * width)); 
        y = -spawnDistance;
        targetX = Math.max(spawnDistance, Math.min(width - spawnDistance, Math.random() * width)); 
        targetY = height + spawnDistance;
        break;
      case 3: // Bottom
        x = Math.max(spawnDistance, Math.min(width - spawnDistance, Math.random() * width)); 
        y = height + spawnDistance;
        targetX = Math.max(spawnDistance, Math.min(width - spawnDistance, Math.random() * width)); 
        targetY = -spawnDistance;
        break;
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

    const newBird: BirdPosition = {
      id: Math.random().toString(36).substring(7),
      bird: birdType, x, y, velocityX, velocityY,
      direction: velocityX > 0 ? 'right' : 'left',
      initialY: y,
      status: 'flying',
    };
    
    setBirds(prev => [...prev, newBird]);
  }, [gameOver, gameStarted, seconds, getScaledSize]);


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
    const bird = birds.find(b => b.id === birdId);
    if (bird && bird.status === 'flying') {
      // Only track individual hit, totals calculated automatically
      setHitHistory(prev => [
        ...prev,
        {
          birdType: bird.bird.name,
          points: bird.bird.points,
          timestamp: Date.now()
        }
      ]);
      
      // Add floating points animation
      const newFloatingPoint = {
        id: Math.random().toString(36).substring(7),
        points: bird.bird.points,
        x: bird.x,
        y: bird.y,
        opacity: 1
      };
      setFloatingPoints(prev => [...prev, newFloatingPoint]);
      
      if (dieAudioRef.current) {
        dieAudioRef.current.currentTime = 0;
        dieAudioRef.current.play();
      }
      if (gunAudioRef.current) {
        gunAudioRef.current.currentTime = 0;
        gunAudioRef.current.play();
      }
      
      setBirds(prevBirds =>
        prevBirds.map(b =>
          b.id === birdId
            ? { ...b, status: 'hit', velocityX: 0, velocityY: 2 } 
            : b
        )
      );

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
  }, [birds, address, toast]);

  const moveBirds = useCallback(() => {
    if (gameOver || !gameStarted) return;
    
    setBirds(prev => prev.map(bird => {
      if (!gameContainerRef.current) return bird;
      
      const { clientWidth: width, clientHeight: height } = gameContainerRef.current;
      
      if (bird.status === 'hit') {
        const gravity = 0.1;
        const newVelocityY = bird.velocityY + gravity;
        const newY = bird.y + newVelocityY;

        if (newY > height + 100) {
          return null;
        }
        return { ...bird, y: newY, velocityY: newVelocityY };
      }

      let newX = bird.x + bird.velocityX;
      let newY = bird.y + bird.velocityY;

      if (bird.bird.name === 'Butterfly') {
        const waveFrequency = 0.03;
        const waveAmplitude = 1.2;
        newY = bird.initialY + bird.velocityY * (bird.x / bird.velocityX) + Math.sin(bird.x * waveFrequency) * waveAmplitude * 20;
      } else if (bird.bird.name === 'Bee') {
        newX += (Math.random() - 0.5) * 3;
      }
      
      if (newX < -150 || newX > width + 150 || newY < -150 || newY > height + 150) {
        return null;
      }
      
      return { ...bird, x: newX, y: newY };
    }).filter(Boolean) as BirdPosition[]);
    
    animationRef.current = requestAnimationFrame(moveBirds);
  }, [gameOver, gameStarted]);

  

  const resetGame = () => {
    setSeconds(60);
    setBirds([]);
    setGameOver(false);
    setGameStarted(false);
    setCountdown(3);
    setHitHistory([]); // Reset hit history
  };

  const playAgain = () => {
    resetGame();
  };

  // Handle mouse movement for cursor (only when not in hand mode)
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (handModeEnabled) return; // mouse disabled when hand mode controls the bat
    if (!gameContainerRef.current) return;
    const rect = gameContainerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setCursor(prev => ({ ...prev, x, y }));
    // Update bat transform directly for low latency
    if (batRef.current) {
      batRef.current.style.left = `${x}px`;
      batRef.current.style.top = `${y}px`;
      batRef.current.style.transform = 'translate(-50%, -50%)';
    }
  }, [handModeEnabled]);

  // Direct hand position update (no RAF loop, no smoothing)
  const updateHandPosition = useCallback((palmPos: { x: number; y: number }) => {
    if (!handModeEnabled || !gameContainerRef.current) return;
    
    const rect = gameContainerRef.current.getBoundingClientRect();
    const targetX = palmPos.x * rect.width;
    const targetY = palmPos.y * rect.height;
    
    // Direct DOM update for immediate responsiveness
    if (batRef.current) {
      batRef.current.style.left = `${targetX}px`;
      batRef.current.style.top = `${targetY}px`;
      batRef.current.style.transform = 'translate(-50%, -50%)';
    }
    
    // Update cursor state and current position
    setCursor(prev => ({ ...prev, x: targetX, y: targetY }));
    currentHandPosRef.current = { x: targetX, y: targetY };
  }, [handModeEnabled]);

  // Update cursor animation
  useEffect(() => {
    if (!cursor.isHitting) return;

    const animationInterval = setInterval(() => {
      setCursor(prev => {
        const newTimer = prev.hitTimer + 0.1; // 10 FPS = 0.1 seconds per frame (faster than original 5 FPS but not too fast)
        const newFrame = Math.floor(newTimer * 10); // 10 FPS

        if (newFrame >= 2) { // 2 frames total (0, 1) - complete in ~200ms
          return {
            ...prev,
            isHitting: false,
            hitFrame: 0,
            hitTimer: 0
          };
        }

        return {
          ...prev,
          hitFrame: newFrame,
          hitTimer: newTimer
        };
      });
    }, 100); // 10 FPS - faster than original 5 FPS but not too fast

    return () => clearInterval(animationInterval);
  }, [cursor.isHitting]);

  // Floating points animation effect
  useEffect(() => {
    if (floatingPoints.length === 0) return;

    const animationInterval = setInterval(() => {
      setFloatingPoints(prev => 
        prev.map(point => ({
          ...point,
          y: point.y - 4, // Move up faster (was 2)
          opacity: point.opacity - 0.04 // Fade out faster (was 0.02)
        })).filter(point => point.opacity > 0) // Remove when fully faded
      );
    }, 30); // Faster FPS (was 50ms = 20 FPS, now 30ms = 33 FPS)

    return () => clearInterval(animationInterval);
  }, [floatingPoints]);

  // Handle mouse click for bat hitting animation
  const handleGameAreaClick = useCallback((e: React.MouseEvent) => {
    if (gunAudioRef.current) {
      gunAudioRef.current.currentTime = 0;
      gunAudioRef.current.play();
    }
    
    // Start hit animation
    setCursor(prev => ({
      ...prev,
      isHitting: true,
      hitFrame: 0,
      hitTimer: 0
    }));

    // Check for collision with birds at click position using responsive hit radius
    if (gameContainerRef.current) {
      const rect = gameContainerRef.current.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;
      
      // Use responsive hit radius based on container size
      const hitRadius = getScaledSize(24);

      // Check collision with each flying bird using distance-based detection
      birds.forEach(bird => {
        if (bird.status === 'flying') {
          const distance = Math.sqrt(
            Math.pow(clickX - bird.x, 2) + 
            Math.pow(clickY - bird.y, 2)
          );

          // Check if click is within responsive hit radius of bird
          if (distance < hitRadius) {
            catchBird(bird.id);
          }
        }
      });
    }
  }, [birds, catchBird, getScaledSize]);

  useEffect(() => {
    // Play countdown audio immediately when countdown starts
    if (countdown === 3 && countdownAudioRef.current) {
      countdownAudioRef.current.currentTime = 0;
      countdownAudioRef.current.play();
    }

    const countdownTimer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          setGameStarted(true);
          return 0;
        }
        if (countdownAudioRef.current) {
          countdownAudioRef.current.currentTime = 0;
          countdownAudioRef.current.play();
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(countdownTimer);
  }, [countdown]);

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
  }, [gameStarted, gameOver]);

  useEffect(() => {
    if (!gameStarted || gameOver) return;
    const spawnLoop = () => {
      const spawnDelay = 250 + (seconds / 60) * 600;
      if (Math.random() < 0.15) createFlock();
      else createBird();
      spawnTimeoutRef.current = setTimeout(spawnLoop, spawnDelay);
    };
    spawnLoop();
    animationRef.current = requestAnimationFrame(moveBirds);
    return () => {
      if (spawnTimeoutRef.current) clearTimeout(spawnTimeoutRef.current);
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [gameStarted, gameOver, seconds, createBird, createFlock, moveBirds]);

  useEffect(() => {
    if (gameStarted && !gameOver) {
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
  }, [gameStarted, gameOver]);

  useEffect(() => {
    if (gameOver) {
      if (gameoverAudioRef.current) {
        gameoverAudioRef.current.currentTime = 0;
        gameoverAudioRef.current.play();
      }
    }
  }, [gameOver]);

  useEffect(() => {
    if (gameOver && hitHistory.length > 0 && address) {
      saveGameData({
        sessionType: 'single',
        hostAddress: address,
        score,
        hits,
        hitHistory,
        durationSec: 60 - seconds,
      }).then(() => {
        console.log("✅ Single player game data saved to Supabase!");
      }).catch((err) => {
        console.error("❌ Failed to save single player game data:", err);
      });
    }
  }, [gameOver, hitHistory, address, score, hits, seconds]);

  if (gameOver) {
    return (
      // --- MODIFICATION: Added 'select-none' to prevent highlighting ---
      <div className="min-h-screen w-full bg-background text-foreground font-press-start flex flex-col items-center justify-center select-none">
        <audio ref={gameoverAudioRef} src="/audio/gameover.mp3" preload="auto" />
        <h1 className="text-4xl mb-8">Game Over!</h1>
        <div className="text-2xl mb-8">Final Score: {score}</div>
        <div className="text-2xl mb-8">Total Hits: {hits}</div>
        <div className="flex gap-4">
          <Button onClick={playAgain} className="bg-primary text-primary-foreground hover:opacity-90 font-press-start text-lg px-8 py-4">
            Play Again
          </Button>
          <Button onClick={onBackToMenu} variant="outline" className="font-press-start text-lg px-8 py-4">
            Main Menu
          </Button>
        </div>
      </div>
    );
  }

  return (
    // --- MODIFICATION: Added 'select-none' to prevent highlighting ---
    <div className="min-h-screen w-full bg-background text-foreground font-press-start flex flex-col items-center justify-start p-8 relative select-none">
      <div className="absolute left-0 top-0 w-full flex justify-between px-8 pt-6 z-20">
        <div className="flex flex-col items-start">
          <div className="text-lg pointer-events-none">Time: {formatTime(seconds)}</div>
          <div className="text-lg pointer-events-none">Score: {score} | Hits: {hits}</div>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={() => setHandModeEnabled((prev) => !prev)}
            className={`${handModeEnabled ? "bg-green-600 hover:bg-green-700" : "bg-blue-600 hover:bg-blue-700"} text-white px-4 py-2 rounded`}
            title={handModeEnabled ? "Disable Hand Mode" : "Enable Hand Mode"}
          >
            {handModeEnabled ? "Hand Mode: ON" : "Hand Mode: OFF"}
          </Button>
          <Button onClick={onBackToMenu} className="bg-red-500 text-white px-4 py-2 rounded hover:bg-red-600">
            Leave Game
          </Button>
        </div>
      </div>
      <audio ref={dieAudioRef} src="/audio/die.mp3" preload="auto" />
      <audio ref={gunAudioRef} src="/audio/gun.mp3" preload="auto" />
      <audio ref={bgMusicRef} src="/audio/gamemusic.mp3" preload="auto" loop />
      <audio ref={countdownAudioRef} src="/audio/Countdown.mp3" preload="auto" />
      <div className="w-full max-w-4xl flex justify-center items-start mt-24 z-10">
        <div 
          ref={gameContainerRef}
          className="w-full max-w-4xl aspect-[16/9] bg-gradient-to-b from-sky-200 via-blue-200 to-blue-300 relative overflow-hidden rounded-lg border-4 border-gray-300 shadow-lg"
          style={{ 
            cursor: handModeEnabled ? 'none' : 'none',
            backgroundImage: 'url(/background.jpg)',
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
            position: 'relative'
          }}
          onMouseMove={handleMouseMove}
          onClick={handleGameAreaClick}
        >
          {/* Background overlay for opacity effect */}
          <div 
            className="absolute inset-0 bg-gradient-to-b from-sky-200/70 via-blue-200/60 to-blue-300/70"
            style={{ pointerEvents: 'none' }}
          />
          {/* Custom Bat Cursor */}
          <div 
            ref={batRef}
            className="absolute pointer-events-none z-50"
            style={{
              left: `${cursor.x}px`,
              top: `${cursor.y}px`,
              transform: 'translate(-50%, -50%)',
              width: `${getScaledSize(48)}px`, // Responsive bat width
              height: `${getScaledSize(180)}px`, // Responsive bat height
              backgroundImage: 'url(/player.png)',
              backgroundSize: `${getScaledSize(96)}px ${getScaledSize(180)}px`, // Responsive background size
              backgroundPosition: cursor.isHitting ? `-${cursor.hitFrame * getScaledSize(48)}px 0` : '0 0', // Responsive frame positioning
              imageRendering: 'pixelated'
            }}
          />

          {!gameStarted && (
            <div className="absolute inset-0 flex items-center justify-center z-50 bg-black/20">
              <div className="text-6xl text-white font-bold">{countdown}</div>
            </div>
          )}

          {birds.map((bird) => (
            <div
              key={bird.id}
              className={`absolute flex items-center justify-center transform -translate-x-1/2 -translate-y-1/2 ${
                bird.status === 'flying' ? 'cursor-pointer' : 'cursor-default'
              }`}
              style={{
                left: `${bird.x}px`,
                top: `${bird.y}px`,
                width: `${getScaledSize(96)}px`,
                height: `${getScaledSize(96)}px`,
              }}
              onClick={bird.status === 'flying' ? () => catchBird(bird.id) : undefined}
            >
              <img
                src={bird.bird.image}
                alt={bird.bird.name}
                className="pointer-events-none transition-transform duration-200"
                style={{
                  width: `${getScaledSize(80)}px`,
                  height: `${getScaledSize(80)}px`,
                  transform: `
                    scaleX(${bird.direction === 'left' ? 1 : -1}) 
                    ${bird.status === 'hit' ? 'scaleY(-1) rotate(15deg)' : 'scaleY(1)'}
                  `,
                }}
              />
            </div>
          ))}

          {/* Floating Points Animation */}
          {floatingPoints.map((point) => (
            <div
              key={point.id}
              className="absolute pointer-events-none z-40 text-yellow-400 font-bold text-lg"
              style={{
                left: `${point.x}px`,
                top: `${point.y}px`,
                transform: 'translate(-50%, -50%)',
                opacity: point.opacity,
                textShadow: '2px 2px 4px rgba(0,0,0,0.8)',
              }}
            >
              +{point.points}
            </div>
          ))}
        </div>
      </div>
      {gameStarted && !gameOver && <Toaster />}
      {/* Hand tracking preview lives outside the game container in bottom-right */}
      <HandTrackingView
        enabled={handModeEnabled}
        onEnter={() => console.log("Hand mode entered")}
        onExit={() => console.log("Hand mode exited")}
        onFingerMove={undefined}
        onPinch={() => {
          // Only process hits during active game
          if (!gameStarted || gameOver) return;
          
          // Trigger hit animation
          setCursor(prev => ({ ...prev, isHitting: true, hitFrame: 0, hitTimer: 0 }));
          if (gunAudioRef.current) {
            gunAudioRef.current.currentTime = 0;
            gunAudioRef.current.play();
          }
          
          // Use current real-time hand position for hit detection (same as mouse)
          if (currentHandPosRef.current) {
            const hitRadius = getScaledSize(24);
            const cx = currentHandPosRef.current.x;
            const cy = currentHandPosRef.current.y;
            
            birds.forEach(bird => {
              if (bird.status === 'flying') {
                const distance = Math.sqrt(Math.pow(cx - bird.x, 2) + Math.pow(cy - bird.y, 2));
                if (distance < hitRadius) {
                  catchBird(bird.id);
                }
              }
            });
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

      {/* No calibration UI: simple palm control + pinch to hit */}
    </div>
  );
};

export default GameScreen;
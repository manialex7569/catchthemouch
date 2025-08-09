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

interface CursorState {
  x: number;
  y: number;
  isHitting: boolean;
  hitFrame: number;
  hitTimer: number;
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

  const [birds, setBirds] = useState<BirdPosition[]>([]);
  const [gameOver, setGameOver] = useState(false);
  const [isBeingKicked, setIsBeingKicked] = useState(false);
  const [showPlayerList, setShowPlayerList] = useState(false);
  const [cursor, setCursor] = useState<CursorState>({
    x: 0,
    y: 0,
    isHitting: false,
    hitFrame: 0,
    hitTimer: 0
  });
  const batRef = useRef<HTMLDivElement | null>(null);

  const gameContainerRef = useRef<HTMLDivElement>(null);
  const intervalRef = useRef<NodeJS.Timeout>();
  const animationRef = useRef<number>();
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
      setFloatingPoints(prev => [...prev, newFloatingPoint]);
      
      // Share hit data with all players via react-together
      setAllHitHistories(prev => ({
        ...prev,
        [myId]: [...(prev[myId] || []), newHit]
      }));
      
      if (dieAudioRef.current) { dieAudioRef.current.currentTime = 0; dieAudioRef.current.play(); }
      if (gunAudioRef.current) { gunAudioRef.current.currentTime = 0; gunAudioRef.current.play(); }
      
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
  }, [birds, address, myId, toast]);

  const moveBirds = useCallback(() => {
    if (gameOver || !gameStarted || waitingForPlayers) return;
    setBirds(prev => prev.map(bird => {
      if (!gameContainerRef.current) return bird;
      const { clientWidth: width, clientHeight: height } = gameContainerRef.current;
      if (bird.status === 'hit') {
        const gravity = 0.1;
        const newVelocityY = bird.velocityY + gravity;
        const newY = bird.y + newVelocityY;
        if (newY > height + 100) { return null; }
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
  }, [gameOver, gameStarted, waitingForPlayers]);

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
        setBirds([]);
        setGameOver(false);
        setHasSavedGameData(false); // Reset save flag for new game
        if (gameId === 1) {
            setMyTotalScore(0);
            setMyTotalHits(0);
        }
    }
  }, [gameId, myId, setMyHitHistory, setBirds, setMyTotalScore, setMyTotalHits]);

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
    animationRef.current = requestAnimationFrame(moveBirds);
    return () => {
      if (spawnTimeoutRef.current) clearTimeout(spawnTimeoutRef.current);
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [gameStarted, gameOver, waitingForPlayers, seconds, createBird, createFlock, moveBirds]);

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
    setCursor(prev => ({ ...prev, x, y }));
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
    // Only play gun sound if game is started and not clicking on UI elements
    if (gameStarted && !gameOver) {
      if (gunAudioRef.current) {
        gunAudioRef.current.currentTime = 0;
        gunAudioRef.current.play();
      }
    }
    
    // Start hit animation
    setCursor(prev => ({
      ...prev,
      isHitting: true,
      hitFrame: 0,
      hitTimer: 0
    }));

    // Check for collision with birds at click position using responsive hit radius
    if (gameContainerRef.current && gameStarted && !gameOver) {
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
  }, [gameStarted, gameOver, birds, catchBird, getScaledSize]);

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
          className="w-full max-w-4xl aspect-[16/9] bg-gradient-to-b from-sky-200 via-blue-200 to-blue-300 relative overflow-hidden rounded-lg border-4 border-gray-300 shadow-lg"
          style={{ 
            cursor: 'none',
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
              transform: 'translate(-50%, -50%)', // Center the bat on cursor
              width: `${getScaledSize(48)}px`, // Responsive bat width
              height: `${getScaledSize(180)}px`, // Responsive bat height
              backgroundImage: 'url(/player.png)',
              backgroundSize: `${getScaledSize(96)}px ${getScaledSize(180)}px`, // Responsive background size
              backgroundPosition: cursor.isHitting ? `-${cursor.hitFrame * getScaledSize(48)}px 0` : '0 0', // Responsive frame positioning
              imageRendering: 'pixelated'
            }}
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
          setCursor(prev => ({ ...prev, isHitting: true, hitFrame: 0, hitTimer: 0 }));
          if (gunAudioRef.current) { gunAudioRef.current.currentTime = 0; gunAudioRef.current.play(); }
          
          // Use current real-time hand position for hit detection (same as mouse)
          if (currentHandPosRef.current) {
            const hitRadius = getScaledSize(24);
            const cx = currentHandPosRef.current.x;
            const cy = currentHandPosRef.current.y;
            
            birds.forEach(bird => {
              if (bird.status === 'flying') {
                const distance = Math.sqrt(Math.pow(cx - bird.x, 2) + Math.pow(cy - bird.y, 2));
                if (distance < hitRadius) { catchBird(bird.id); }
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
    </div>
  );
};

export default GameScreenMultiplayer;
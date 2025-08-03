import { useState, useContext } from "react";
import StartScreen from "@/components/StartScreen";
import BirdSelectScreen from "@/components/InsectSelectScreen";
import GameScreen from "@/components/GameScreen";
import GameScreenMultiplayer from "@/components/GameScreenMultiplayer";
import LeaderboardScreen from "@/components/LeaderboardScreen";
import { SessionParamsContext } from "../App";

const PASSWORD = import.meta.env.VITE_MULTISYNQ_SESSION_PASSWORD || 'catchbirds';

const Index = () => {
  const [currentScreen, setCurrentScreen] = useState<'start' | 'select' | 'game' | 'leaderboard'>('start');
  const [gameMode, setGameMode] = useState<'singleplayer' | 'multiplayer' | null>(null);
  const [multiplayerOptions, setMultiplayerOptions] = useState<{ isHost?: boolean; roomId?: string } | null>(null);
  const { setSessionName, setSessionPassword } = useContext(SessionParamsContext);

  const handleStart = () => {
    setCurrentScreen('select');
  };

  const handleStartGame = (mode: 'singleplayer' | 'multiplayer', options?: { isHost?: boolean; roomId?: string }) => {
    if (mode === 'multiplayer') {
      if (options?.isHost) {
        // Host: create random session name
        const randomName = Math.random().toString(36).substring(2, 16);
        setSessionName(randomName);
        setSessionPassword(PASSWORD);
        setMultiplayerOptions({ isHost: true, roomId: randomName });
      } else if (options?.roomId) {
        setSessionName(options.roomId);
        setSessionPassword(PASSWORD);
        setMultiplayerOptions({ isHost: false, roomId: options.roomId });
      }
    } else {
      setSessionName(null);
      setSessionPassword(null);
      setMultiplayerOptions(null);
    }
    setGameMode(mode);
    setCurrentScreen('game');
  };

  const handleBackToMenu = () => {
    setCurrentScreen('start');
    setGameMode(null);
    setMultiplayerOptions(null);
    setSessionName(null);
    setSessionPassword(null);
  };

  const handleShowLeaderboard = () => {
    setCurrentScreen('leaderboard');
  };

  const handleBackFromLeaderboard = () => {
    setCurrentScreen('select');
  };

  return (
    <div className="min-h-screen overflow-hidden">
      {currentScreen === 'start' && <StartScreen onStart={handleStart} />}
      {currentScreen === 'select' && <BirdSelectScreen onStartGame={handleStartGame} onShowLeaderboard={handleShowLeaderboard} />}
      {currentScreen === 'game' && gameMode === 'singleplayer' && <GameScreen onBackToMenu={handleBackToMenu} />}
      {currentScreen === 'game' && gameMode === 'multiplayer' && (
        <GameScreenMultiplayer
          onBackToMenu={handleBackToMenu}
          isHost={multiplayerOptions?.isHost}
          roomId={multiplayerOptions?.roomId}
        />
      )}
      {currentScreen === 'leaderboard' && <LeaderboardScreen onBack={handleBackFromLeaderboard} />}
    </div>
  );
};

export default Index;

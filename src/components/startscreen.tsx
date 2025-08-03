import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { WalletButton } from "./WalletButton";
import { useAccount } from "wagmi";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";


interface StartScreenProps {
  onStart: () => void;
}

const StartScreen = ({ onStart }: StartScreenProps) => {
  const { isConnected } = useAccount();
  const introAudioRef = useRef<HTMLAudioElement | null>(null);
  const [animalsLanded, setAnimalsLanded] = useState(false);

  // This effect handles the intro animation and audio playback.
  useEffect(() => {
    // Attempt to play the intro audio. If blocked by the browser, it will fail silently without breaking the app.
    introAudioRef.current?.play().catch(error => {
      console.log("Audio autoplay was prevented by the browser:", error);
    });

    // Reduced delay for snappier animation
    const animationTimer = setTimeout(() => {
      setAnimalsLanded(true);
    }, 300); // Reduced from 400ms to 300ms for faster start

    // Cleanup the timer if the component unmounts.
    return () => clearTimeout(animationTimer);
  }, []);

  // Improved base classes with shorter duration and better easing for natural flying movement
  const animalBaseClass = "absolute transition-all ease-[cubic-bezier(0.25,0.46,0.45,0.94)] transform duration-[1500ms]";
  
  // Enhanced responsive sizing with more breakpoints
  const animalSizeClass = "w-[2.5em] h-[2.5em] sm:w-[3em] sm:h-[3em] md:w-[3.4em] md:h-[3.4em] lg:w-[3.8em] lg:h-[3.8em] xl:w-[4em] xl:h-[4em]";

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center bg-background text-foreground font-press-start overflow-hidden p-2 sm:p-4 relative">
      <audio ref={introAudioRef} src="/audio/intro.mp3" preload="auto" />



      {/* The main title container with improved responsive positioning */}
      <div className="relative mb-8 sm:mb-12 z-10">
        {/* --- Enhanced Animal Animations with GameScreen-style flying patterns --- */}
        {/* Birds fly in from different sides with natural movement before settling on letters */}

        {/* 1. Butterfly (on the 'C' of Catch) - Wave motion like in GameScreen */}
        <img
          src="/animals/butterfly.gif"
          alt="Butterfly"
          className={`
            ${animalBaseClass} ${animalSizeClass} delay-100 scale-x-[-1]
            ${animalsLanded
              ? 'top-[0.1em] sm:top-[-1em] left-[3%] sm:left-[5.2%] opacity-100 rotate-[-15deg]' // Final position on 'C'
              : 'top-[-80%] left-[-60%] opacity-0 rotate-45 scale-75' // Fly in from top-left with wave motion
            }
          `}
          style={{
            transform: animalsLanded ? '' : 'translateX(0px) translateY(0px) rotate(45deg) scale(0.75)',
            transition: animalsLanded ? 'all 1.5s cubic-bezier(0.25,0.46,0.45,0.94)' : 'none'
          }}
        />

        {/* 2. Bee (on the 'h' of Catch) - Random movement like in GameScreen */}
        <img
          src="/animals/bee.gif"
          alt="Bee"
          className={`
            ${animalBaseClass} ${animalSizeClass} delay-200
            ${animalsLanded
              ? 'top-[-0.1em] sm:top-[-1em] left-[25%] sm:left-[31%] opacity-100 rotate-[15deg]' // Final position on 'h'
              : 'top-[-60%] right-[-80%] opacity-0 rotate-[-30deg] scale-75' // Fly in from top-right with random movement
            }
          `}
          style={{
            transform: animalsLanded ? '' : 'translateX(0px) translateY(0px) rotate(-30deg) scale(0.75)',
            transition: animalsLanded ? 'all 1.5s cubic-bezier(0.25,0.46,0.45,0.94)' : 'none'
          }}
        />

        {/* 3. Blue Mouch (on the 'T' of The) */}
        <img
          src="/animals/bluemouch.gif"
          alt="Blue Mouch"
          className={`
            ${animalBaseClass} ${animalSizeClass} delay-300
            ${animalsLanded
              ? 'top-[-10em] sm:top-[-1.6em] left-1/2 -translate-x-1/2 opacity-100 rotate-[5deg]' // Final position on 'T'
              : 'top-[-80%] right-[-60%] opacity-0 rotate-[-45deg] scale-75' // Fly in from top-right
            }
          `}
          style={{
            transform: animalsLanded ? '' : 'translateX(0px) translateY(0px) rotate(-45deg) scale(0.75)',
            transition: animalsLanded ? 'all 1.5s cubic-bezier(0.25,0.46,0.45,0.94)' : 'none'
          }}
        />

        {/* 4. Mouch (on the 'h' of Mouch) - Dramatic entrance */}
        <img
          src="/animals/mouch.gif"
          alt="Mouch"
          className={`
            ${animalBaseClass} ${animalSizeClass} delay-400
            ${animalsLanded
              ? 'top-[5em] sm:top-[0.1em] right-[-10%] sm:right-[-2%] opacity-100 rotate-[25deg]' // Final position on 'h' of Mouch
              : 'top-[-40%] right-[-100%] opacity-0 rotate-[-15deg] scale-75' // Fly in from far right
            }
          `}
          style={{
            transform: animalsLanded ? '' : 'translateX(0px) translateY(0px) rotate(-15deg) scale(0.75)',
            transition: animalsLanded ? 'all 1.5s cubic-bezier(0.25,0.46,0.45,0.94)' : 'none'
          }}
        />

        {/* Enhanced Fluid Typography with better responsive scaling */}
        <h1 
          className="text-center leading-tight whitespace-nowrap px-2 overflow-hidden"
          style={{ 
            fontSize: 'clamp(1.5rem, 6vw, 6rem)', // Much better scaling range for landscape
            lineHeight: '1.1', // Tighter line height for single line
            minHeight: '1.1em', // Ensure consistent height
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '100%',
            maxWidth: '100vw',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          Catch The Mouch
        </h1>
      </div>

      <div className="flex flex-col gap-3 sm:gap-4 z-10 items-center">
        <WalletButton />
        
        {/* Tooltip for the disabled "Play Game" button */}
        <TooltipProvider>
          <Tooltip delayDuration={100}>
            <TooltipTrigger asChild>
              {/* A span is needed to wrap the disabled button for the tooltip to trigger correctly. */}
              <span tabIndex={!isConnected ? 0 : -1}>
                <Button
                  onClick={onStart}
                  disabled={!isConnected}
                  className="bg-primary text-primary-foreground hover:opacity-90 font-press-start text-base sm:text-lg px-6 sm:px-8 py-3 sm:py-4 disabled:opacity-50 disabled:cursor-not-allowed"
                  // Prevent click events on the button itself when disabled
                  style={!isConnected ? { pointerEvents: "none" } : {}}
                >
                  Play Game
                </Button>
              </span>
            </TooltipTrigger>
            {/* The tooltip content is only rendered if the wallet is not connected. */}
            {!isConnected && (
              <TooltipContent>
                <p>Please connect your wallet to play</p>
              </TooltipContent>
            )}
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
};

export default StartScreen;

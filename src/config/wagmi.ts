import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { defineChain } from 'viem';

// Define Monad Testnet chain
const monadTestnet = defineChain({
    id: 10143,
    name: 'Monad Testnet',
    nativeCurrency: {
        decimals: 18,
        name: 'MON',
        symbol: 'MON',
    },
    rpcUrls: {
        default: {
            http: ['https://testnet-rpc.monad.xyz'],
        },
    },
    blockExplorers: {
        default: {
            name: 'Monad Explorer',
            url: 'https://testnet.monadexplorer.com',
        },
    },
    testnet: true,
});

// Configure chains
export const config = getDefaultConfig({
    appName: 'Mouch Game',
    projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || 'your-project-id',
    chains: [monadTestnet],
    ssr: false, // Set to false for Vite
});

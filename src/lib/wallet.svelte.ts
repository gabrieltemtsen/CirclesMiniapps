import { createPublicClient, http, getAddress, toHex, encodeFunctionData, zeroAddress, isAddress, hashMessage, hashTypedData, keccak256, encodeAbiParameters, concat } from 'viem';
import { gnosis } from 'viem/chains';
import {
	createSafeSmartAccount,
	createSmartAccountClient,
	retrieveAccountAddressFromPasskeys,
	ENTRYPOINT_ADDRESS_V07
} from '@cometh/connect-sdk-4337';
import { createPimlicoClient } from 'permissionless/clients/pimlico';

const COMETH_API_KEY = import.meta.env.VITE_COMETH_API_KEY;
const PIMLICO_API_KEY = import.meta.env.VITE_PIMLICO_API_KEY;
const PIMLICO_SPONSORSHIP_POLICY_ID = import.meta.env.VITE_PIMLICO_SPONSORSHIP_POLICY_ID;
const PIMLICO_URL = `https://api.pimlico.io/v2/100/rpc?apikey=${PIMLICO_API_KEY}`;

const SAFE_ADDRESS_KEY = 'safe_address';
const CIRCLES_RPC_URL = 'https://rpc.aboutcircles.com/';
const SAFE_TX_SERVICE_URL = 'https://safe-transaction-gnosis-chain.safe.global';

// Minimal Safe ABI for execTransaction and owner queries
const SAFE_ABI = [
	{
		inputs: [
			{ name: 'to', type: 'address' },
			{ name: 'value', type: 'uint256' },
			{ name: 'data', type: 'bytes' },
			{ name: 'operation', type: 'uint8' },
			{ name: 'safeTxGas', type: 'uint256' },
			{ name: 'baseGas', type: 'uint256' },
			{ name: 'gasPrice', type: 'uint256' },
			{ name: 'gasToken', type: 'address' },
			{ name: 'refundReceiver', type: 'address' },
			{ name: 'signatures', type: 'bytes' }
		],
		name: 'execTransaction',
		outputs: [{ name: 'success', type: 'bool' }],
		stateMutability: 'payable',
		type: 'function'
	},
	{
		inputs: [],
		name: 'getOwners',
		outputs: [{ name: '', type: 'address[]' }],
		stateMutability: 'view',
		type: 'function'
	},
	{
		inputs: [],
		name: 'getThreshold',
		outputs: [{ name: '', type: 'uint256' }],
		stateMutability: 'view',
		type: 'function'
	}
] as const;

let address = $state<string>('');
let connected = $state(false);
let connecting = $state(false);
let avatarName = $state<string>('');
let avatarImageUrl = $state<string>('');
let manuallyDisconnected = false;
let autoConnecting = false;

// Child safe state — when set, transactions are routed through execTransaction
let childSafeAddress = $state<string>('');
let childSafeAvatarName = $state<string>('');
let childSafeAvatarImageUrl = $state<string>('');

// Child safe picker state — shown after login when owned child safes are found
let pickerVisible = $state(false);
let pickerSafes = $state<string[]>([]);
let pickerProfiles = $state<Record<string, { name: string; previewImageUrl: string }>>({});
let pickerResolve: ((addr: string | null) => void) | null = null;

function getSavedSafeAddress(): string {
	return localStorage.getItem(SAFE_ADDRESS_KEY) ?? '';
}

let smartAccountClient: any = null;
let publicClient: any = null;

function getConfig() {
	if (!COMETH_API_KEY) {
		console.error('VITE_COMETH_API_KEY is not set in .env');
		return null;
	}
	return {
		apiKey: COMETH_API_KEY,
		bundlerUrl: `https://bundler.cometh.io/100?apikey=${COMETH_API_KEY}`
	};
}

async function connectWithPasskey() {
	const config = getConfig();
	if (!config) return;

	connecting = true;
	try {
		const resolved = await retrieveAccountAddressFromPasskeys({
			apiKey: config.apiKey,
			chain: gnosis
		});
		await connect(resolved as string);
	} catch (error: any) {
		console.error('Passkey connection error:', error);
		if (!autoConnecting) alert('Failed to connect: ' + error.message);
	} finally {
		connecting = false;
	}
}

async function connect(safeAddress: string) {
	const config = getConfig();
	if (!config) return;

	connecting = true;

	try {
		safeAddress = getAddress(safeAddress);
		localStorage.setItem(SAFE_ADDRESS_KEY, safeAddress);

		publicClient = createPublicClient({
			chain: gnosis,
			transport: http(),
			cacheTime: 60_000,
			batch: { multicall: { wait: 50 } }
		});

		const smartAccount = await createSafeSmartAccount({
			apiKey: config.apiKey,
			publicClient,
			chain: gnosis,
			smartAccountAddress: safeAddress
		});

		const paymasterClient = createPimlicoClient({
			transport: http(PIMLICO_URL),
			chain: gnosis,
			entryPoint: { address: ENTRYPOINT_ADDRESS_V07, version: '0.7' }
		});

		smartAccountClient = createSmartAccountClient({
			account: smartAccount,
			chain: gnosis,
			bundlerTransport: http(PIMLICO_URL),
			paymaster: paymasterClient,
			paymasterContext: PIMLICO_SPONSORSHIP_POLICY_ID
				? { sponsorshipPolicyId: PIMLICO_SPONSORSHIP_POLICY_ID }
				: undefined,
			userOperation: {
				estimateFeesPerGas: async () => {
					const gasPrice = await paymasterClient.getUserOperationGasPrice();
					return gasPrice.fast;
				}
			}
		});

		address = safeAddress;
		connected = true;
		fetchAvatarInfo(safeAddress);
	} catch (error: any) {
		console.error('Connection error:', error);
		if (!autoConnecting) alert('Failed to connect: ' + error.message);
	} finally {
		connecting = false;
	}
}

async function fetchAvatarInfo(safeAddress: string) {
	try {
		const res = await fetch(CIRCLES_RPC_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'circles_getProfileByAddress',
				params: [safeAddress]
			})
		});
		const json = await res.json();
		const result = json?.result;
		avatarName = result?.name ?? '';
		avatarImageUrl = result?.previewImageUrl ?? '';
	} catch {
		avatarName = '';
		avatarImageUrl = '';
	}
}

/** Build the prevalidated signature bytes for a single owner with threshold=1. */
function buildPrevalidatedSignature(ownerAddress: string): `0x${string}` {
	const ownerPadded = ownerAddress.toLowerCase().replace('0x', '').padStart(64, '0');
	return `0x${ownerPadded}${'0'.repeat(64)}01`;
}

/** Wrap a transaction as a Safe.execTransaction call to be sent from the primary safe. */
function buildSafeExecTx(ownerAddress: string, safeAddress: string, tx: { to: string; data?: string; value?: string }) {
	const signature = buildPrevalidatedSignature(ownerAddress);
	return {
		to: safeAddress,
		value: '0',
		data: encodeFunctionData({
			abi: SAFE_ABI,
			functionName: 'execTransaction',
			args: [
				tx.to as `0x${string}`,
				tx.value ? BigInt(tx.value) : 0n,
				(tx.data || '0x') as `0x${string}`,
				0,
				0n,
				0n,
				0n,
				zeroAddress,
				zeroAddress,
				signature
			]
		})
	};
}

async function sendTransaction(tx: { to: string; data?: string; value?: string }) {
	if (!smartAccountClient) throw new Error('Wallet not connected');
	const finalTx = childSafeAddress ? buildSafeExecTx(address, childSafeAddress, tx) : tx;
	return smartAccountClient.sendTransaction({
		to: finalTx.to,
		data: (finalTx.data as `0x${string}`) || '0x',
		value: finalTx.value ? BigInt(finalTx.value) : 0n
	});
}

async function sendTransactions(txs: { to: string; data?: string; value?: string }[]) {
	if (!smartAccountClient) throw new Error('Wallet not connected');
	const finalTxs = childSafeAddress
		? txs.map((tx) => buildSafeExecTx(address, childSafeAddress, tx))
		: txs;
	return smartAccountClient.sendTransaction({
		calls: finalTxs.map((tx) => ({
			to: tx.to,
			data: (tx.data as `0x${string}`) || '0x',
			value: tx.value ? BigInt(tx.value) : 0n
		}))
	});
}

function disconnect() {
	smartAccountClient = null;
	publicClient = null;
	localStorage.removeItem(SAFE_ADDRESS_KEY);
	if (address) localStorage.removeItem(`cometh-connect-${address}`);
	address = '';
	avatarName = '';
	avatarImageUrl = '';
	connected = false;
	manuallyDisconnected = true;
	childSafeAddress = '';
	childSafeAvatarName = '';
	childSafeAvatarImageUrl = '';
	pickerVisible = false;
	pickerSafes = [];
	pickerProfiles = {};
	if (pickerResolve) { pickerResolve(null); pickerResolve = null; }
}

/** Call on page mount. Auto-connects from saved address or passkey; skips if user disconnected this session. */
async function autoConnect() {
	if (connected || connecting || manuallyDisconnected) return;
	autoConnecting = true;
	try {
		const target = getSavedSafeAddress();
		if (target) {
			await connect(target);
		} else {
			await connectWithPasskey();
		}
	} finally {
		autoConnecting = false;
	}
}

/**
 * Connect via passkey then show the child safe picker if owned child safes exist.
 * Returns after the user has made their selection (or if there were no child safes).
 * Use this instead of connectWithPasskey() for any sign-in button in the UI.
 */
async function connectAndPick() {
	await connectWithPasskey();
	if (!connected) return;
	await _openPickerIfNeeded();
}

/**
 * Same as autoConnect but opens the child safe picker afterward.
 * Use this on page mount instead of autoConnect() for pages that support child safe switching.
 */
async function autoConnectAndPick() {
	await autoConnect();
	if (!connected) return;
	await _openPickerIfNeeded();
}

async function _openPickerIfNeeded() {
	const safes = await fetchOwnedChildSafes();
	if (safes.length === 0) return;
	pickerSafes = safes;
	pickerProfiles = {};
	pickerVisible = true;
	// Fetch Circles profiles for child safes + primary in one batch (best-effort)
	fetchProfilesBatch([address, ...safes]).then((profiles) => {
		pickerProfiles = profiles;
	});
	// Wait for the user to pick (ChildSafePicker calls resolveChildSafePick)
	await new Promise<void>((res) => {
		pickerResolve = (addr) => {
			if (addr) loginAsChildSafe(addr);
			res();
		};
	});
}

/** Batch-fetch Circles profiles. Returns a map from lowercased address to profile fields. */
async function fetchProfilesBatch(addresses: string[]): Promise<Record<string, { name: string; previewImageUrl: string }>> {
	const out: Record<string, { name: string; previewImageUrl: string }> = {};
	if (!addresses.length) return out;
	try {
		const res = await fetch(CIRCLES_RPC_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'circles_getProfileByAddressBatch',
				params: [addresses]
			})
		});
		const json = await res.json();
		const results = Array.isArray(json?.result) ? json.result : [];
		for (const r of results) {
			if (r?.address) {
				out[r.address.toLowerCase()] = {
					name: r.name ?? '',
					previewImageUrl: r.previewImageUrl ?? ''
				};
			}
		}
	} catch {
		// network/parse failure — return empty map; UI falls back to truncated address
	}
	return out;
}

/** Called by ChildSafePicker when the user selects an account (null = stay as primary). */
function resolveChildSafePick(addr: string | null) {
	pickerVisible = false;
	if (pickerResolve) {
		pickerResolve(addr);
		pickerResolve = null;
	}
}

/**
 * Build a Safe "contract signature" that wraps innerSig as a v=0 type entry.
 *
 * Safe's isValidSignature with v=0 treats the signer as a contract and calls
 * isValidSignature on it. Layout (per Safe source):
 *   r = signer address, left-padded to 32 bytes
 *   s = byte offset to dynamic data = 65 (0x41), left-padded to 32 bytes
 *   v = 0x00
 *   [uint256 innerSig.length][innerSig bytes]
 */
function buildSafeContractSig(signerAddress: string, innerSig: `0x${string}`): `0x${string}` {
	const signerPadded = signerAddress.toLowerCase().replace('0x', '').padStart(64, '0');
	const offsetPadded = (65n).toString(16).padStart(64, '0'); // 0x41 = 65
	const v = '00';
	const innerBytes = innerSig.replace('0x', '');
	const innerLen = (innerBytes.length / 2).toString(16).padStart(64, '0');
	return `0x${signerPadded}${offsetPadded}${v}${innerLen}${innerBytes}`;
}

// keccak256("SafeMessage(bytes message)")
const SAFE_MSG_TYPEHASH = '0x60b3cbf8b4a223d68d641b3b6ddf9a298e7f33710cf3d3a9d1146b5a6150fbca' as const;
// keccak256("EIP712Domain(uint256 chainId,address verifyingContract)")
const SAFE_DOMAIN_TYPEHASH = '0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218' as const;

function safeDomainSeparator(chainId: number, safeAddress: string): `0x${string}` {
	return keccak256(
		encodeAbiParameters(
			[{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
			[SAFE_DOMAIN_TYPEHASH, BigInt(chainId), safeAddress as `0x${string}`]
		)
	);
}

/**
 * Encode the SafeMessage preimage bytes for a Safe — exactly what
 * CompatibilityFallbackHandler.encodeMessageDataForSafe returns.
 *   abi.encodePacked(0x19, 0x01, domainSeparator(safe), keccak256(SAFE_MSG_TYPEHASH || keccak256(message)))
 * keccak256 of this preimage equals the SafeMessage EIP-712 hash for that safe.
 */
function safeMessagePreimage(chainId: number, safeAddress: string, message: `0x${string}`): `0x${string}` {
	const innerStructHash = keccak256(
		encodeAbiParameters(
			[{ type: 'bytes32' }, { type: 'bytes32' }],
			[SAFE_MSG_TYPEHASH, keccak256(message)]
		)
	);
	return concat(['0x1901', safeDomainSeparator(chainId, safeAddress), innerStructHash]);
}

async function signMessage(message: string) {
	if (!smartAccountClient) throw new Error('Wallet not connected');
	// The auth service verifies via Safe.isValidSignature(bytes rawMsgBytes, sig),
	// which on-chain computes: challenge = SafeMessage EIP-712 of keccak256(rawMsgBytes).
	//
	// signTypedData bypasses the SDK's internal generateSafeMessageMessage() wrapper
	// (which would add an extra EIP-191 hash), letting us pass rawMsgBytes directly
	// as the SafeMessage content — matching exactly what the auth service verifies.
	const chainId = smartAccountClient.chain?.id ?? 100;
	const rawMsgBytes = toHex(new TextEncoder().encode(message));

	if (childSafeAddress) {
		// Verification flow on chain:
		//   childSafe.isValidSignature(rawMsgBytes, sig)
		//     → safeMsgHash_child = EIP712(SafeMessage{rawMsgBytes}, domain=child)
		//     → parses contract-sig (v=0) → calls primarySafe.isValidSignature(messageData_child, innerSig)
		//       (note: the FULL preimage messageData_child is forwarded, NOT the hash)
		//     → primarySafe computes safeMsgHash_primary = EIP712(SafeMessage{messageData_child as bytes}, domain=primary)
		//       (Safe's bytes-overload does keccak256(messageData_child) = safeMsgHash_child internally)
		//     → checks passkey signed safeMsgHash_primary
		//
		// To get the matching passkey signature, we must hand the full preimage to
		// account.sign (which encodes its argument as bytes inside SafeMessage). Passing
		// just safeMsgHash_child would cause viem to keccak256 it once more — mismatching.
		const messageDataChild = safeMessagePreimage(chainId, childSafeAddress, rawMsgBytes);
		const innerSig = await smartAccountClient.account.sign({ hash: messageDataChild });
		const signature = buildSafeContractSig(address, innerSig);
		const verified = await publicClient.verifyMessage({
			address: childSafeAddress,
			message,
			signature
		});
		return { signature, verified };
	}

	const safeAddress = smartAccountClient.account.address;
	const signature = await smartAccountClient.account.signTypedData({
		domain: { chainId, verifyingContract: safeAddress },
		types: { SafeMessage: [{ name: 'message', type: 'bytes' }] },
		primaryType: 'SafeMessage',
		message: { message: rawMsgBytes }
	});
	const verified = await publicClient.verifyMessage({
		address: safeAddress,
		message,
		signature
	});
	return { signature, verified };
}

/**
 * Sign a message using the standard EIP-191 + ERC-1271 path.
 *
 * Use this for any consumer that verifies via isValidSignature(eip191Hash, sig),
 * including XMTP (libxmtp passes eip191_hash_message(text) to isValidSignature)
 * and standard EIP-1271 wallets.
 *
 * Flow:
 *   account.signMessage({ message }) → generateSafeMessageMessage(msg) = hashMessage(msg) = eip191Hash
 *   → signs SafeMessage{ message: eip191Hash } via signTypedData
 *   Verifier calls isValidSignature(eip191Hash, sig) → Safe reconstructs same SafeMessage hash ✓
 *
 * NOTE: This is NOT compatible with the auth service (which calls isValidSignature(rawBytes, sig)).
 * Use wallet.signMessage() for the auth service flow.
 */
async function signErc1271Message(message: string) {
	if (!smartAccountClient) throw new Error('Wallet not connected');

	if (childSafeAddress) {
		// Verifier passes hashMessage(message) (32 bytes) to childSafe.isValidSignature.
		// Child handler wraps as SafeMessage with the EIP-191 hash as the bytes message,
		// gets safeMsgHash_child, then forwards messageData_child to primarySafe.
		// We hand the same preimage to account.sign so the keccak depths match.
		const chainId = smartAccountClient.chain?.id ?? 100;
		const eip191Hash = hashMessage(message);
		const messageDataChild = safeMessagePreimage(chainId, childSafeAddress, eip191Hash);
		const innerSig = await smartAccountClient.account.sign({ hash: messageDataChild });
		return buildSafeContractSig(address, innerSig);
	}

	const signature = await smartAccountClient.account.signMessage({ message });
	return signature as `0x${string}`;
}

/**
 * Fetch safes where the given address is an owner, via Safe Transaction Service,
 * then verify on-chain that the primary address is truly an owner with threshold >= 1.
 * Returns verified child safe addresses (excluding the primary safe itself).
 */
async function fetchOwnedChildSafes(): Promise<string[]> {
	if (!address || !publicClient) return [];

	try {
		const res = await fetch(`${SAFE_TX_SERVICE_URL}/api/v1/owners/${address}/safes/`);
		if (!res.ok) return [];
		const data = await res.json();
		const candidates: string[] = (data?.safes ?? [])
			.filter((s: string) => isAddress(s))
			.map((s: string) => getAddress(s))
			.filter((s: string) => s.toLowerCase() !== address.toLowerCase());

		if (!candidates.length) return [];

		// Verify on-chain: primary address must be an owner and threshold >= 1
		const contracts = candidates.flatMap((safeAddr) => [
			{ address: safeAddr as `0x${string}`, abi: SAFE_ABI, functionName: 'getOwners' as const },
			{ address: safeAddr as `0x${string}`, abi: SAFE_ABI, functionName: 'getThreshold' as const }
		]);

		const results = await publicClient.multicall({ contracts, allowFailure: true });

		const verified: string[] = [];
		candidates.forEach((safeAddr, i) => {
			const ownersResult = results[i * 2];
			const thresholdResult = results[i * 2 + 1];
			if (ownersResult?.status !== 'success' || thresholdResult?.status !== 'success') return;
			const owners = ownersResult.result as string[];
			const threshold = thresholdResult.result as bigint;
			if (
				Array.isArray(owners) &&
				owners.some((o) => o.toLowerCase() === address.toLowerCase()) &&
				BigInt(threshold) >= 1n
			) {
				verified.push(safeAddr);
			}
		});

		return verified;
	} catch {
		return [];
	}
}

/**
 * Switch to acting on behalf of a child safe.
 * The primary safe (controlled by passkeys) will wrap all transactions as execTransaction calls.
 */
async function loginAsChildSafe(safeAddress: string) {
	if (!connected) throw new Error('Wallet not connected');
	childSafeAddress = getAddress(safeAddress);
	childSafeAvatarName = '';
	childSafeAvatarImageUrl = '';

	try {
		const res = await fetch(CIRCLES_RPC_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: 1,
				method: 'circles_getProfileByAddress',
				params: [childSafeAddress]
			})
		});
		const json = await res.json();
		const result = json?.result;
		childSafeAvatarName = result?.name ?? '';
		childSafeAvatarImageUrl = result?.previewImageUrl ?? '';
	} catch {
		// profile not found — fine
	}
}

/** Return to acting as the primary safe. */
function logoutChildSafe() {
	childSafeAddress = '';
	childSafeAvatarName = '';
	childSafeAvatarImageUrl = '';
}

export const wallet = {
	// When acting as a child safe, expose child safe address so miniapps see the right address
	get address() { return childSafeAddress || address; },
	get primaryAddress() { return address; },
	get connected() { return connected; },
	get connecting() { return connecting; },
	get avatarName() { return childSafeAddress ? childSafeAvatarName : avatarName; },
	get avatarImageUrl() { return childSafeAddress ? childSafeAvatarImageUrl : avatarImageUrl; },
	get childSafeAddress() { return childSafeAddress; },
	get primaryAvatarName() { return avatarName; },
	get primaryAvatarImageUrl() { return avatarImageUrl; },
	get pickerVisible() { return pickerVisible; },
	get pickerSafes() { return pickerSafes; },
	get pickerProfiles() { return pickerProfiles; },
	getSavedSafeAddress,
	connect,
	connectWithPasskey,
	connectAndPick,
	autoConnect,
	autoConnectAndPick,
	resolveChildSafePick,
	disconnect,
	sendTransaction,
	sendTransactions,
	signMessage,
	signErc1271Message,
	fetchOwnedChildSafes,
	loginAsChildSafe,
	logoutChildSafe
};

<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import AppNavigation from '$lib/AppNavigation.svelte';
	import { wallet } from '$lib/wallet.svelte.ts';
	import ApprovalPopup from '$lib/ApprovalPopup.svelte';
	import RestrictedActionPopup from '$lib/RestrictedActionPopup.svelte';
	import {
		truncateAddr,
		getAvatarInitial as _getAvatarInitial,
		createMessageHandler,
		createApprovalHandlers,
		type PendingRequest
	} from '$lib/iframeHost.ts';
	import {
		trackMiniappIframeLoaded,
		trackMiniappIframeLoadFailed,
		trackMiniappRequestedAddress,
		trackMiniappRequestedTransaction,
		trackMiniappRequestedSignature,
		trackMiniappTxApproved,
		trackMiniappTxRejected,
		trackMiniappTxPolicyBlocked,
		trackMiniappSignApproved,
		trackMiniappSignRejected
	} from '$lib/analytics';

	type AnalyticsContext = { slug: string; name?: string };

	type Props = {
		src: string;
		iframeTitle: string;
		sandbox?: string;
		backLabel?: string;
		onBack: () => void;
		title?: string;
		getAppData?: () => string | null;
		isOffline?: boolean;
		enforceTxPolicy?: boolean;
		offlineState?: Snippet;
		emptyState?: Snippet;
		beforeIframe?: Snippet;
		analytics?: AnalyticsContext;
		iframeLoadTimeoutMs?: number;
	};

	let {
		src,
		iframeTitle,
		sandbox = 'allow-scripts allow-forms allow-same-origin',
		backLabel = 'back',
		onBack,
		title,
		getAppData,
		isOffline = false,
		enforceTxPolicy = false,
		offlineState,
		emptyState,
		beforeIframe,
		analytics,
		iframeLoadTimeoutMs = 15000
	}: Props = $props();

	let showLogout = $state(false);
	let chipEl = $state<HTMLElement>();
	let pendingRequest: PendingRequest | null = $state(null);
	let blockedAction: { reason: string; transactions: any[] } | null = $state(null);

	// pendingSource is kept outside $state to avoid Svelte proxying the cross-origin Window object,
	// which triggers "Blocked a frame from accessing a cross-origin frame".
	let pendingSource: MessageEventSource | null = null;

	let iframeEl: HTMLIFrameElement = $state() as HTMLIFrameElement;

	// Analytics state — kept outside $state, only read inside handlers.
	const mountedAt = Date.now();
	let iframeLoaded = false;
	let loadTimeoutId: ReturnType<typeof setTimeout> | null = null;
	let pendingShownAt: number | null = null;

	function secondsSinceLoad(): number {
		return Math.round((Date.now() - mountedAt) / 1000);
	}

	const getAvatarInitial = () => _getAvatarInitial(wallet.avatarName, wallet.address);

	function handleWindowClick(e: MouseEvent) {
		if (showLogout && chipEl && !chipEl.contains(e.target as Node)) {
			showLogout = false;
		}
	}

	function openUserMenu() {
		showLogout = !showLogout;
	}

	function postToIframe(data: any) {
		try {
			iframeEl?.contentWindow?.postMessage(data, '*');
		} catch {
			// cross-origin access blocked — ignore
		}
	}

	const handleMessage = createMessageHandler({
		getAppData: () => getAppData?.() ?? null,
		setPending: (req) => {
			pendingRequest = req;
			if (req) pendingShownAt = Date.now();
		},
		setPendingSource: (s) => { pendingSource = s; },
		get enforceTxPolicy() { return enforceTxPolicy; },
		onPolicyRejection: (info) => {
			blockedAction = info;
			if (analytics) {
				trackMiniappTxPolicyBlocked({
					slug: analytics.slug,
					name: analytics.name,
					reason: info.reason
				});
			}
		},
		onAddressRequested: (info) => {
			if (!analytics) return;
			trackMiniappRequestedAddress({
				slug: analytics.slug,
				name: analytics.name,
				wallet_connected: info.hadWallet,
				seconds_since_load: secondsSinceLoad()
			});
		},
		onTransactionRequested: (info) => {
			if (!analytics) return;
			trackMiniappRequestedTransaction({
				slug: analytics.slug,
				name: analytics.name,
				tx_count: info.txCount,
				had_wallet: info.hadWallet,
				seconds_since_load: secondsSinceLoad()
			});
		},
		onSignatureRequested: (info) => {
			if (!analytics) return;
			trackMiniappRequestedSignature({
				slug: analytics.slug,
				name: analytics.name,
				signature_type: info.signatureType
			});
		},
		onTxAutoRejected: (info) => {
			if (!analytics) return;
			trackMiniappTxRejected({
				slug: analytics.slug,
				name: analytics.name,
				reject_reason: info.reason
			});
		},
		onSignAutoRejected: (info) => {
			if (!analytics) return;
			trackMiniappSignRejected({
				slug: analytics.slug,
				name: analytics.name,
				reject_reason: info.reason
			});
		}
	});

	const baseApprovalHandlers = createApprovalHandlers({
		getPending: () => pendingRequest,
		getPendingSource: () => pendingSource,
		setPending: (req) => {
			pendingRequest = req;
			if (!req) pendingShownAt = null;
		},
		setPendingSource: (s) => { pendingSource = s; }
	});

	async function handleApprove(): Promise<string> {
		const req = pendingRequest;
		const startedAt = pendingShownAt;
		const result = await baseApprovalHandlers.handleApprove();
		if (analytics && req) {
			const latency = startedAt ? Date.now() - startedAt : undefined;
			if (req.kind === 'tx') {
				trackMiniappTxApproved({
					slug: analytics.slug,
					name: analytics.name,
					tx_count: req.transactions?.length ?? 0,
					approve_latency_ms: latency
				});
			} else {
				trackMiniappSignApproved({
					slug: analytics.slug,
					name: analytics.name,
					signature_type: req.signatureType ?? 'erc1271'
				});
			}
		}
		return result;
	}

	function handleReject() {
		const req = pendingRequest;
		baseApprovalHandlers.handleReject();
		if (analytics && req) {
			if (req.kind === 'tx') {
				trackMiniappTxRejected({
					slug: analytics.slug,
					name: analytics.name,
					reject_reason: 'user_rejected'
				});
			} else {
				trackMiniappSignRejected({
					slug: analytics.slug,
					name: analytics.name,
					reject_reason: 'user_rejected'
				});
			}
		}
	}

	onMount(() => {
		window.addEventListener('message', handleMessage);

		if (analytics && src) {
			loadTimeoutId = setTimeout(() => {
				if (iframeLoaded) return;
				trackMiniappIframeLoadFailed({
					slug: analytics.slug,
					name: analytics.name,
					time_to_timeout_ms: iframeLoadTimeoutMs,
					is_offline: !navigator.onLine
				});
			}, iframeLoadTimeoutMs);
		}

		return () => {
			window.removeEventListener('message', handleMessage);
			if (loadTimeoutId !== null) {
				clearTimeout(loadTimeoutId);
				loadTimeoutId = null;
			}
		};
	});

	$effect(() => {
		if (wallet.connected) {
			postToIframe({ type: 'wallet_connected', address: wallet.address });
		} else {
			postToIframe({ type: 'wallet_disconnected' });
		}
	});

	function handleIframeLoad() {
		if (!iframeLoaded) {
			iframeLoaded = true;
			if (loadTimeoutId !== null) {
				clearTimeout(loadTimeoutId);
				loadTimeoutId = null;
			}
			if (analytics) {
				trackMiniappIframeLoaded({
					slug: analytics.slug,
					name: analytics.name,
					load_ms: Date.now() - mountedAt
				});
			}
		}
		if (wallet.connected) {
			postToIframe({ type: 'wallet_connected', address: wallet.address });
		}
		const raw = getAppData?.() ?? null;
		if (raw) {
			try {
				postToIframe({ type: 'app_data', data: atob(raw) });
			} catch {
				postToIframe({ type: 'app_data', data: raw });
			}
		}
	}
</script>

<svelte:window onclick={handleWindowClick} />

<div class="iframe-topbar">
	<div class="topbar-left">
		<button class="back-btn" onclick={onBack}>&#8592; {backLabel}</button>
		<AppNavigation />
		{#if title}<h1>{title}</h1>{/if}
	</div>
	<div class="header-right">
		{#if wallet.connected}
			<div
				class="user-chip"
				bind:this={chipEl}
				class:open={showLogout}
				onclick={openUserMenu}
				role="button"
				tabindex="0"
				onkeydown={(e) => e.key === 'Enter' && openUserMenu()}
			>
				<div class="avatar-img-wrap">
					{#if wallet.avatarImageUrl}
						<img class="avatar-img" src={wallet.avatarImageUrl} alt="avatar" />
					{:else}
						<span class="avatar-placeholder">{getAvatarInitial()}</span>
					{/if}
				</div>
				<span class="user-name">{wallet.avatarName || truncateAddr(wallet.address)}</span>
				{#if showLogout}
					<button
						class="logout-btn"
						onclick={(e) => { e.stopPropagation(); wallet.disconnect(); showLogout = false; }}
					>
						Log out
					</button>
				{/if}
			</div>
		{:else}
			<button
				class="connect-btn"
				onclick={() => wallet.connectAndPick()}
				disabled={wallet.connecting}
			>
				{#if wallet.connecting}
					<span class="btn-spinner"></span>
					Connecting...
				{:else}
					Sign in
				{/if}
			</button>
		{/if}
	</div>
</div>

{#if !wallet.connected && wallet.connectionError}
	<div class="connection-error" role="alert">
		<span>Sign-in failed: {wallet.connectionError}</span>
		<button class="connection-error-retry" onclick={() => wallet.connectAndPick()}>Retry</button>
	</div>
{/if}

{@render beforeIframe?.()}

<div class="iframe-card">
	{#if isOffline && offlineState}
		{@render offlineState()}
	{:else if !src && emptyState}
		{@render emptyState()}
	{:else if src}
		<iframe bind:this={iframeEl} {src} {sandbox} title={iframeTitle} onload={handleIframeLoad}></iframe>
	{/if}
</div>

{#if pendingRequest}
	<ApprovalPopup
		request={pendingRequest}
		onapprove={handleApprove}
		onreject={handleReject}
	/>
{/if}

{#if blockedAction}
	<RestrictedActionPopup
		reason={blockedAction.reason}
		transactions={blockedAction.transactions}
		onclose={() => { blockedAction = null; }}
	/>
{/if}

<style>
	.topbar-left h1 {
		margin: 0;
		font-size: 20px;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--ink);
	}

	.connection-error {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 8px 12px;
		margin: 0 0 12px;
		font-size: 13px;
		background: rgba(220, 38, 38, 0.08);
		border: 1px solid rgba(220, 38, 38, 0.25);
		border-radius: var(--radius-sm, 8px);
		color: #b91c1c;
	}

	.connection-error-retry {
		background: none;
		border: 1px solid rgba(185, 28, 28, 0.4);
		border-radius: var(--radius-pill);
		padding: 3px 12px;
		font-size: 12px;
		font-weight: 600;
		color: #b91c1c;
		cursor: pointer;
		transition: background 0.12s;
	}

	.connection-error-retry:hover {
		background: rgba(185, 28, 28, 0.12);
	}

	.iframe-card {
		flex: 1;
		display: flex;
		flex-direction: column;
		border: 1px solid var(--line);
		border-radius: var(--radius-card);
		overflow: hidden;
		background: var(--card);
		min-height: 0;
		box-shadow: var(--shadow-card);
	}

	iframe {
		flex: 1;
		width: 100%;
		height: 100%;
		border: none;
		display: block;
	}
</style>

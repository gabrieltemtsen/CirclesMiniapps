<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import AppNavigation from '$lib/AppNavigation.svelte';

	const baseUrl = import.meta.env.VITE_BASE_URL;
	import { wallet } from '$lib/wallet.svelte.ts';
	import ApprovalPopup from '$lib/ApprovalPopup.svelte';

	type MiniApp = { slug?: string; name: string; logo: string; url: string; description?: string; tags: string[]; isHidden?: boolean };

	let app: MiniApp | null = $state(null);
	let notFound = $state(false);
	let iframeSrc = $state('');
	let isOffline = $state(false);
	let showLogout = $state(false);
	let chipEl = $state<HTMLElement>();

	let childSafes = $state<string[]>([]);
	let loadingChildSafes = $state(false);

	function handleWindowClick(e: MouseEvent) {
		if (showLogout && chipEl && !chipEl.contains(e.target as Node)) {
			showLogout = false;
		}
	}

	// pendingSource is kept outside $state to avoid Svelte proxying the cross-origin Window object,
	// which triggers "Blocked a frame from accessing a cross-origin frame".
	let pendingSource: MessageEventSource | null = null;
	let pendingRequest: {
		kind: 'tx' | 'sign';
		transactions?: any[];
		message?: string;
		signatureType?: 'erc1271' | 'raw';
		requestId: string;
	} | null = $state(null);

	let iframeEl: HTMLIFrameElement = $state() as HTMLIFrameElement;

	function truncateAddr(addr: string): string {
		return addr.slice(0, 6) + '...' + addr.slice(-4);
	}

	function getAvatarInitial(): string {
		const name = wallet.avatarName;
		if (name) return name.trim().charAt(0).toUpperCase();
		return wallet.address ? wallet.address.slice(2, 4).toUpperCase() : '?';
	}

	async function openUserMenu() {
		showLogout = !showLogout;
		if (showLogout && wallet.connected && !loadingChildSafes) {
			loadingChildSafes = true;
			try {
				childSafes = await wallet.fetchOwnedChildSafes();
			} finally {
				loadingChildSafes = false;
			}
		}
	}

	async function switchToChildSafe(addr: string) {
		showLogout = false;
		await wallet.loginAsChildSafe(addr);
	}

	/** Post a message to a cross-origin source window safely. */
	function postTo(source: MessageEventSource | null, data: any) {
		try {
			(source as Window)?.postMessage(data, '*');
		} catch {
			// cross-origin access blocked — ignore
		}
	}

	function postToIframe(data: any) {
		try {
			iframeEl?.contentWindow?.postMessage(data, '*');
		} catch {
			// cross-origin access blocked — ignore
		}
	}

	function handleMessage(event: MessageEvent) {
		const { data } = event;
		if (!data || !data.type) return;

		switch (data.type) {
			case 'request_address':
				if (wallet.connected) {
					postTo(event.source, { type: 'wallet_connected', address: wallet.address });
				} else {
					postTo(event.source, { type: 'wallet_disconnected' });
				}
				const raw = $page.url.searchParams.get('data');
				if (raw) {
					try {
						postTo(event.source, { type: 'app_data', data: atob(raw) });
					} catch {
						postTo(event.source, { type: 'app_data', data: raw });
					}
				}
				break;

			case 'send_transactions':
				if (!wallet.connected) {
					postTo(event.source, { type: 'tx_rejected', reason: 'Wallet not connected', requestId: data.requestId });
					return;
				}
				if (!data.transactions || !Array.isArray(data.transactions)) {
					postTo(event.source, { type: 'tx_rejected', reason: 'No transactions provided', requestId: data.requestId });
					return;
				}
				pendingSource = event.source;
				pendingRequest = {
					kind: 'tx',
					transactions: data.transactions,
					requestId: data.requestId
				};
				break;

			case 'sign_message':
				if (!wallet.connected) {
					postTo(event.source, { type: 'sign_rejected', reason: 'Wallet not connected', requestId: data.requestId });
					return;
				}
				if (!data.message) {
					postTo(event.source, { type: 'sign_rejected', reason: 'No message provided', requestId: data.requestId });
					return;
				}
				pendingSource = event.source;
				pendingRequest = {
					kind: 'sign',
					message: data.message,
					signatureType: data.signatureType === 'raw' ? 'raw' : 'erc1271',
					requestId: data.requestId
				};
				break;
		}
	}

	onMount(() => {
		const syncOnlineState = () => {
			isOffline = !navigator.onLine;
		};

		syncOnlineState();
		window.addEventListener('message', handleMessage);
		window.addEventListener('online', syncOnlineState);
		window.addEventListener('offline', syncOnlineState);

		wallet.autoConnectAndPick();

		fetch('/miniapps.json')
			.then((r) => r.json())
			.then((data: MiniApp[]) => {
				const currentSlug = $page.params.slug;
				const found = data.find((a) => a.slug === currentSlug);
				if (found) {
					app = found;
					iframeSrc = found.url;
				} else {
					notFound = true;
				}
			})
			.catch(() => {
				notFound = true;
			});

		return () => {
			window.removeEventListener('message', handleMessage);
			window.removeEventListener('online', syncOnlineState);
			window.removeEventListener('offline', syncOnlineState);
		};
	});

	// Push wallet status to iframe whenever connection changes
	$effect(() => {
		if (wallet.connected) {
			postToIframe({ type: 'wallet_connected', address: wallet.address });
		} else {
			postToIframe({ type: 'wallet_disconnected' });
		}
	});

	function handleIframeLoad() {
		if (wallet.connected) {
			postToIframe({ type: 'wallet_connected', address: wallet.address });
		}
		const raw = $page.url.searchParams.get('data');
		if (raw) {
			try {
				postToIframe({ type: 'app_data', data: atob(raw) });
			} catch {
				postToIframe({ type: 'app_data', data: raw });
			}
		}
	}

	function goBack() {
		goto('/miniapps');
	}

	async function handleApprove(): Promise<string> {
		if (!pendingRequest) return '';

		if (pendingRequest.kind === 'tx') {
			const hash = await wallet.sendTransactions(pendingRequest.transactions!);
			postTo(pendingSource, { type: 'tx_success', hashes: [hash], requestId: pendingRequest.requestId });
			pendingRequest = null;
			pendingSource = null;
			return hash;
		}

		if (pendingRequest.kind === 'sign') {
			const { signature, verified } = pendingRequest.signatureType === 'raw'
				? await wallet.signMessage(pendingRequest.message!)
				: { signature: await wallet.signErc1271Message(pendingRequest.message!), verified: true };
			postTo(pendingSource, { type: 'sign_success', signature, verified, requestId: pendingRequest.requestId });
			pendingRequest = null;
			pendingSource = null;
			return signature;
		}

		return '';
	}

	function handleReject() {
		if (!pendingRequest) return;
		const rejectType = pendingRequest.kind === 'tx' ? 'tx_rejected' : 'sign_rejected';
		postTo(pendingSource, { type: rejectType, reason: 'User rejected', requestId: pendingRequest.requestId });
		pendingRequest = null;
		pendingSource = null;
	}
</script>

<svelte:window onclick={handleWindowClick} />

<svelte:head>
	<title>{app ? app.name : 'Mini App'} - {baseUrl}</title>
</svelte:head>

<div class="page">
	{#if notFound}
		<div class="iframe-topbar">
			<div class="topbar-left">
				<button class="back-btn" onclick={goBack}>&#8592; back</button>
				<AppNavigation />
			</div>
		</div>
		<div class="not-found">
			<p>App not found.</p>
		</div>
	{:else}
		<div class="iframe-topbar">
			<div class="topbar-left">
				<button class="back-btn" onclick={goBack}>&#8592; back</button>
				<AppNavigation />
			</div>
			<div class="header-right">
				{#if wallet.connected}
					<div class="user-chip-wrap">
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
						</div>
						{#if wallet.childSafeAddress}
							<div class="child-safe-badge">
								<span>Signing as: {truncateAddr(wallet.primaryAddress)}</span>
								<button class="badge-close" onclick={() => wallet.logoutChildSafe()}>&#215;</button>
							</div>
						{/if}
						{#if showLogout}
							<div class="chip-dropdown" role="menu" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
								{#if wallet.childSafeAddress}
									<button
										class="dropdown-action"
										onclick={() => { wallet.logoutChildSafe(); showLogout = false; }}
									>
										Back to primary safe
									</button>
									<div class="dropdown-divider"></div>
								{/if}
								<button
									class="dropdown-action logout"
									onclick={(e) => { e.stopPropagation(); wallet.disconnect(); showLogout = false; }}
								>
									Log out
								</button>
								{#if childSafes.length > 0}
									<div class="dropdown-divider"></div>
									<div class="dropdown-section-label">Switch to child account</div>
									{#each childSafes as safe (safe)}
										<button
											class="dropdown-action child-safe-item"
											onclick={() => switchToChildSafe(safe)}
										>
											{truncateAddr(safe)}
											{#if safe === wallet.childSafeAddress}
												<span class="active-dot"></span>
											{/if}
										</button>
									{/each}
								{:else if loadingChildSafes}
									<div class="dropdown-loading">Loading safes...</div>
								{/if}
							</div>
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

		<div class="iframe-card">
			{#if isOffline}
				<div class="offline-frame-state">
					<h2>Mini app unavailable offline</h2>
					<p>
						This mini app is embedded from its own site, so it can&apos;t load until your
						connection returns. The cached Circles shell is still available.
					</p>
				</div>
			{:else if iframeSrc}
				<iframe
					bind:this={iframeEl}
					src={iframeSrc}
					sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-top-navigation-by-user-activation"
					title={app ? app.name : 'Mini App'}
					onload={handleIframeLoad}
				></iframe>
			{/if}
		</div>
	{/if}
</div>


<!-- Approval Popup -->
{#if pendingRequest}
	<ApprovalPopup
		request={pendingRequest}
		onapprove={handleApprove}
		onreject={handleReject}
	/>
{/if}

<style>
	.page {
		height: 100vh;
		display: flex;
		flex-direction: column;
		max-width: 720px;
		margin: 0 auto;
		padding: 12px 8px;
		box-sizing: border-box;
		overflow-x: hidden;
	}

	/* Topbar */
	.iframe-topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 12px;
		padding-bottom: 12px;
		border-bottom: 1px solid var(--line);
		margin-bottom: 16px;
		flex-shrink: 0;
	}

	.topbar-left {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 12px;
	}

	.back-btn {
		background: none;
		border: none;
		color: var(--muted);
		font-size: 14px;
		font-weight: 500;
		cursor: pointer;
		padding: 0;
		display: flex;
		align-items: center;
		gap: 4px;
		transition: color 0.15s;
	}

	.back-btn:hover {
		color: var(--ink);
	}

	.header-right {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.connect-btn {
		background: linear-gradient(130deg, var(--accent), var(--accent-mid));
		color: #fff;
		border: none;
		border-radius: var(--radius-pill);
		padding: 8px 18px;
		font-size: 14px;
		font-weight: 600;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 6px;
		transition: opacity 0.15s;
	}

	.connect-btn:hover:not(:disabled) {
		opacity: 0.85;
	}

	.connect-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* User chip wrap — anchor for the dropdown */
	.user-chip-wrap {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 4px;
	}

	/* User chip */
	.user-chip {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 10px 4px 4px;
		border: 1px solid var(--line);
		border-radius: var(--radius-pill);
		background: var(--card);
		cursor: pointer;
		user-select: none;
		transition: border-color 0.15s, background 0.15s;
	}

	.user-chip:hover,
	.user-chip.open {
		border-color: var(--line);
		background: var(--bg-a);
	}

	.avatar-img-wrap {
		width: 26px;
		height: 26px;
		border-radius: 50%;
		overflow: hidden;
		flex-shrink: 0;
		background: var(--line-soft);
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.avatar-img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.avatar-placeholder {
		font-size: 12px;
		font-weight: 600;
		color: var(--muted);
		line-height: 1;
	}

	.user-name {
		font-size: 13px;
		font-weight: 500;
		color: var(--ink);
		max-width: 140px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Child safe badge */
	.child-safe-badge {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 2px 6px 2px 8px;
		border-radius: var(--radius-pill);
		background: var(--accent-soft, rgba(14, 0, 168, 0.08));
		border: 1px solid var(--accent-line, rgba(14, 0, 168, 0.18));
		font-size: 11px;
		font-weight: 500;
		color: var(--accent, #0e00a8);
		white-space: nowrap;
	}

	.badge-close {
		background: none;
		border: none;
		padding: 0 0 0 2px;
		cursor: pointer;
		font-size: 14px;
		line-height: 1;
		color: var(--accent, #0e00a8);
		opacity: 0.6;
		transition: opacity 0.15s;
		display: flex;
		align-items: center;
	}

	.badge-close:hover {
		opacity: 1;
	}

	/* Chip dropdown */
	.chip-dropdown {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		min-width: 180px;
		background: var(--card);
		border: 1px solid var(--line);
		border-radius: var(--radius-card, 12px);
		box-shadow: var(--shadow-card, 0 4px 16px rgba(0, 0, 0, 0.10));
		z-index: 100;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}

	.dropdown-action {
		background: none;
		border: none;
		width: 100%;
		text-align: left;
		padding: 10px 14px;
		font-size: 13px;
		font-weight: 500;
		color: var(--ink);
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 6px;
		transition: background 0.12s;
	}

	.dropdown-action:hover {
		background: var(--bg-a);
	}

	.dropdown-action.logout {
		color: var(--muted);
	}

	.dropdown-action.logout:hover {
		color: var(--ink);
	}

	.dropdown-action.child-safe-item {
		font-size: 12px;
		font-family: monospace;
		color: var(--muted);
	}

	.dropdown-action.child-safe-item:hover {
		color: var(--ink);
	}

	.dropdown-divider {
		height: 1px;
		background: var(--line);
		margin: 2px 0;
	}

	.dropdown-section-label {
		padding: 6px 14px 4px;
		font-size: 11px;
		font-weight: 600;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.dropdown-loading {
		padding: 10px 14px;
		font-size: 12px;
		color: var(--muted);
	}

	.active-dot {
		display: inline-block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent, #0e00a8);
		flex-shrink: 0;
		margin-left: auto;
	}

	.btn-spinner {
		display: inline-block;
		width: 11px;
		height: 11px;
		border: 2px solid rgba(255, 255, 255, 0.35);
		border-top-color: #fff;
		border-radius: 50%;
		animation: spin 0.7s linear infinite;
	}

	/* Iframe card fills remaining space */
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

	.offline-frame-state {
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 32px;
		text-align: center;
		background:
			radial-gradient(700px 240px at 50% 0%, rgba(14, 0, 168, 0.05) 0%, transparent 70%),
			linear-gradient(145deg, rgba(250, 245, 241, 0.85), rgba(246, 247, 249, 0.88));
	}

	.offline-frame-state h2 {
		margin: 0 0 10px;
		font-size: 22px;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--ink);
	}

	.offline-frame-state p {
		margin: 0;
		max-width: 420px;
		font-size: 14px;
		line-height: 1.6;
		color: var(--muted);
	}

	iframe {
		flex: 1;
		width: 100%;
		height: 100%;
		border: none;
	}

	/* Not found */
	.not-found {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--muted);
		font-size: 15px;
	}

	@keyframes spin {
		to { transform: rotate(360deg); }
	}
</style>

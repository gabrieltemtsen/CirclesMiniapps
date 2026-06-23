<script lang="ts">
	let {
		tabs,
		active,
		onselect
	}: {
		tabs: { key: string; label: string }[];
		active: string;
		onselect: (key: string) => void;
	} = $props();
</script>

<div class="tabs" role="tablist" aria-label="Sections">
	{#each tabs as t (t.key)}
		<button
			type="button"
			role="tab"
			aria-selected={t.key === active}
			class:active={t.key === active}
			onclick={() => onselect(t.key)}
		>
			{t.label}
		</button>
	{/each}
</div>

<style>
	.tabs {
		display: flex;
		gap: 4px;
		overflow-x: auto;
		scrollbar-width: none;
		background: var(--card);
		border: 1px solid var(--line);
		border-radius: var(--radius-pill);
		padding: 4px;
		box-shadow: var(--shadow-card);
	}
	.tabs::-webkit-scrollbar {
		display: none;
	}
	button {
		flex: 0 0 auto;
		border: none;
		background: transparent;
		color: var(--muted);
		font-family: inherit;
		font-size: 13px;
		font-weight: 600;
		padding: 8px 16px;
		border-radius: var(--radius-pill);
		cursor: pointer;
		white-space: nowrap;
		transition: background 0.15s, color 0.15s;
	}
	button:hover {
		color: var(--ink);
	}
	button.active {
		background: var(--accent-soft);
		color: var(--accent);
	}
</style>

import { getViewportMetrics, refreshViewportMetricsIfNeeded } from './viewport-scale.js';

const BASE_RADIUS = 15;
const LABEL_BUFFER = 10;
const IMAGE_SIZE = '512';
const CLICK_THRESHOLD = 3;
const SEARCH_RESULT_LIMIT = 5;
const SEARCH_DEBOUNCE_MS = 300;

const SIMILAR_ARTISTS_VIEW = 'similar-artists';
const TOP_SONGS_VIEW = 'top-songs';

const LINK_STROKE_COLOR = '#999';
const AVAILABLE_NODE_STROKE_COLOR = '#00ff88';
const EXPANDED_NODE_STROKE_COLOR = '#6b9fff';
const LABEL_CLASS_NAME = 'font-inter font-light tracking-tight';
const LABEL_FILL_COLOR = '#fafafa';

const PLAY_ICON = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M8 5v14l11-7z"/>
    </svg>
`;

const PAUSE_ICON = `
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="4" width="4" height="16"/>
        <rect x="14" y="4" width="4" height="16"/>
    </svg>
`;

function createGraphData() {
    return {
        nodes: [],
        links: [],
    };
}

function getNodeRadius() {
    return BASE_RADIUS;
}

function getLabelOffset() {
    return BASE_RADIUS + LABEL_BUFFER;
}

function getNodeId(nodeOrId) {
    if (nodeOrId && typeof nodeOrId === 'object') {
        return nodeOrId.id;
    }

    return nodeOrId;
}

function buildLinkKey(sourceId, targetId) {
    return `${sourceId}-${targetId}`;
}

function resolveArtworkUrl(imageUrl) {
    return imageUrl.replace('{w}', IMAGE_SIZE).replace('{h}', IMAGE_SIZE);
}

function hasUsableRelationData(data) {
    return Boolean(data) && !data.error && Object.keys(data).length > 0;
}

function getPrimaryArtist(relationData) {
    return relationData?.data?.[0] || null;
}

function getSimilarArtists(relationData) {
    return getPrimaryArtist(relationData)?.views?.[SIMILAR_ARTISTS_VIEW]?.data || [];
}

function getTopSongs(relationData) {
    return getPrimaryArtist(relationData)?.views?.[TOP_SONGS_VIEW]?.data || [];
}

function setPlayButtonIcon(button) {
    if (button) {
        button.innerHTML = PLAY_ICON;
    }
}

function setPauseButtonIcon(button) {
    if (button) {
        button.innerHTML = PAUSE_ICON;
    }
}

async function requestJson(url, { errorPrefix, fetchOptions } = {}) {
    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
        throw new Error(`${errorPrefix} failed with status ${response.status}`);
    }

    return await response.json();
}

export class ArtistNetworkGraph {
    constructor(svgSelector, options = {}) {
        this.svg = d3.select(svgSelector);
        const viewportMetrics = getViewportMetrics();

        this.width = viewportMetrics.logicalWidth;
        this.height = viewportMetrics.logicalHeight;

        this.nodeMap = new Map();
        this.linkSet = new Set();
        this.relationData = {};
        this.graphData = createGraphData();

        this.simulation = null;
        this.graphGroup = null;
        this.linkLayer = null;
        this.nodeLayer = null;
        this.labelLayer = null;
        this.linkElements = null;
        this.nodeElements = null;
        this.labelElements = null;

        this.currentAudio = null;
        this.currentPlayButton = null;

        this.onNodeExpand = options.onNodeExpand || null;
        this.onNodeCollapse = options.onNodeCollapse || null;
        this.onNodeClick = options.onNodeClick || null;
        this.interactionLocked = false;
        this._handleOrientationChange = () => this._updateViewportSize({ forceRefresh: true });

        this._initializeGraph();
        this._registerViewportListeners();
    }

    setInteractionLocked(locked) {
        this.interactionLocked = locked;
    }

    async init(rootArtistId, options = {}) {
        const { autoExpandRoot = false } = options;

        try {
            this._clearGraph();

            const rootRelationData = await this._fetchRelationData(rootArtistId);
            this.relationData = { [rootArtistId]: rootRelationData };
            const rootArtist = getPrimaryArtist(rootRelationData);

            if (!rootArtist) {
                throw new Error('Root artist data is missing.');
            }

            const rootNode = this.addNode(
                rootArtist.id,
                rootArtist.attributes.name,
                rootArtist.attributes.artwork.url
            );

            const relatedArtists = getSimilarArtists(rootRelationData);
            const relatedIds = relatedArtists.map((artist) => artist.id);

            await this._loadRelationDataForIds(relatedIds);
            this._renderGraph();

            if (autoExpandRoot && rootNode) {
                rootNode.expanded = true;

                const added = await this.extendGraph(rootArtist.id);

                if (added) {
                    this._updateVisualization();
                } else {
                    rootNode.expanded = false;
                }
            }
        } catch (error) {
            console.error('Error initializing graph:', error);
        }
    }

    addNode(id, name, imageURL) {
        if (this.nodeMap.has(id)) {
            return;
        }

        const node = {
            id,
            name,
            imageURL,
            x: this.width / 2 + (Math.random() - 0.5) * 10,
            y: this.height / 2 + (Math.random() - 0.5) * 10,
        };

        this.graphData.nodes.push(node);
        this.nodeMap.set(id, node);

        return node;
    }

    collapseNode(parentNode) {
        const relatedArtists = this._getRelatedArtistsForNode(parentNode.id);
        const neighborIds = new Set(relatedArtists.map((artist) => artist.id));

        this.graphData.links = this.graphData.links.filter((link) => {
            if (!this._isParentNeighborLink(link, parentNode.id, neighborIds)) {
                return true;
            }

            const { sourceId, targetId } = this._getLinkNodeIds(link);
            const neighborId = sourceId === parentNode.id ? targetId : sourceId;

            if (this._isNeighborAnchored(neighborId, parentNode.id, neighborIds)) {
                return true;
            }

            this._removeLinkKeys(sourceId, targetId);
            return false;
        });

        for (const neighborId of neighborIds) {
            this._removeNodeIfOrphaned(neighborId);
        }
    }

    addLink(sourceId, targetId) {
        const linkKey = buildLinkKey(sourceId, targetId);
        const reverseLinkKey = buildLinkKey(targetId, sourceId);

        if (this.linkSet.has(linkKey) || this.linkSet.has(reverseLinkKey)) {
            return;
        }

        const link = { source: sourceId, target: targetId };

        this.graphData.links.push(link);
        this.linkSet.add(linkKey);

        return link;
    }

    async extendGraph(clickedNodeId) {
        if (!(clickedNodeId in this.relationData)) {
            return false;
        }

        const relatedArtists = this._getRelatedArtistsForNode(clickedNodeId);

        for (const artist of relatedArtists) {
            this.addNode(artist.id, artist.attributes.name, artist.attributes.artwork.url);
            this.addLink(clickedNodeId, artist.id);
        }

        const missingIds = relatedArtists
            .map((artist) => artist.id)
            .filter((artistId) => !this.relationData[artistId]);

        await this._loadRelationDataForIds(missingIds);

        return true;
    }

    getShortestPath(fromId, toId) {
        if (!fromId || !toId) {
            return null;
        }

        if (!this.nodeMap.has(fromId) || !this.nodeMap.has(toId)) {
            return null;
        }

        if (fromId === toId) {
            return [this.nodeMap.get(fromId)];
        }

        const adjacency = this._buildAdjacencyMap();
        const queue = [fromId];
        const visited = new Set([fromId]);
        const previous = new Map();

        while (queue.length > 0) {
            const currentId = queue.shift();
            const neighbors = adjacency.get(currentId);

            if (!neighbors) {
                continue;
            }

            for (const neighborId of neighbors) {
                if (visited.has(neighborId)) {
                    continue;
                }

                visited.add(neighborId);
                previous.set(neighborId, currentId);

                if (neighborId === toId) {
                    return this._buildPathFromPreviousMap(previous, toId);
                }

                queue.push(neighborId);
            }
        }

        return null;
    }

    _initializeGraph() {
        this.svg.selectAll('*').remove();
        this.svg.append('defs');

        this.svg
            .attr('width', this.width)
            .attr('height', this.height);

        const zoom = d3.zoom()
            .scaleExtent([0.1, 10])
            .on('zoom', (event) => {
                this.graphGroup.attr('transform', event.transform);
            });

        this.svg.call(zoom);

        this.graphGroup = this.svg.append('g');
        this.svg.call(zoom.transform, d3.zoomIdentity);
    }

    _registerViewportListeners() {
        window.addEventListener('orientationchange', this._handleOrientationChange);
    }

    _updateViewportSize(options = {}) {
        const viewportChanged = refreshViewportMetricsIfNeeded(options);

        if (!viewportChanged) {
            return;
        }

        const viewportMetrics = getViewportMetrics();

        if (viewportMetrics.logicalWidth === this.width && viewportMetrics.logicalHeight === this.height) {
            return;
        }

        this.width = viewportMetrics.logicalWidth;
        this.height = viewportMetrics.logicalHeight;

        this.svg
            .attr('width', this.width)
            .attr('height', this.height);

        if (!this.simulation) {
            return;
        }

        this.simulation.force('center', d3.forceCenter(this.width / 2, this.height / 2));
        this.simulation.alpha(0.15).restart();
    }

    _clearGraph() {
        if (this.simulation) {
            this.simulation.stop();
            this.simulation = null;
        }

        this.graphData = createGraphData();
        this.nodeMap.clear();
        this.linkSet.clear();

        if (this.graphGroup) {
            this.graphGroup.selectAll('*').remove();
        }

        this.linkLayer = null;
        this.nodeLayer = null;
        this.labelLayer = null;
        this.linkElements = null;
        this.nodeElements = null;
        this.labelElements = null;
    }

    _createImagePattern(nodeData, radius) {
        const patternId = `image-${nodeData.id}`;
        const defs = this.svg.select('defs');
        const pattern = defs.append('pattern')
            .attr('id', patternId)
            .attr('patternUnits', 'objectBoundingBox')
            .attr('width', 1)
            .attr('height', 1);

        pattern.append('image')
            .attr('href', resolveArtworkUrl(nodeData.imageURL))
            .attr('width', radius * 2)
            .attr('height', radius * 2)
            .attr('x', 0)
            .attr('y', 0)
            .attr('preserveAspectRatio', 'xMidYMid slice');

        return patternId;
    }

    _showTooltip(node) {
        const tooltipElements = this._getTooltipElements();
        const artistData = this._getArtistData(node.id);

        if (!tooltipElements || !artistData) {
            return;
        }

        tooltipElements.tooltip.classList.remove('hidden');
        tooltipElements.tooltipBackground.style.backgroundImage = `linear-gradient(to top, rgba(0, 0, 0, 0.7), rgba(0, 0, 0, 0.25)), url('${resolveArtworkUrl(node.imageURL)}')`;
        tooltipElements.artistLink.href = artistData.attributes.url;
        tooltipElements.artistNameLabel.innerHTML = artistData.attributes.name;
        tooltipElements.genresLabel.innerHTML = `Genres: ${artistData.attributes.genreNames.join(', ')}`;
        tooltipElements.topTracksContainer.innerHTML = '';

        this._resetAudioState();
        this._renderTopTracks(node.id, tooltipElements.topTracksContainer);
    }

    _renderGraph() {
        if (this.simulation) {
            this.simulation.stop();
        }

        this._createGraphLayers();
        this._refreshGraphElements();
        this._createSimulation();
    }

    _tick() {
        const safeX = (node) => Number.isFinite(node.x) ? node.x : this.width / 2;
        const safeY = (node) => Number.isFinite(node.y) ? node.y : this.height / 2;

        this.linkElements
            .attr('x1', (link) => safeX(link.source))
            .attr('y1', (link) => safeY(link.source))
            .attr('x2', (link) => safeX(link.target))
            .attr('y2', (link) => safeY(link.target));

        this.nodeElements
            .attr('cx', (node) => safeX(node))
            .attr('cy', (node) => safeY(node));

        this.labelElements
            .attr('x', (node) => safeX(node))
            .attr('y', (node) => safeY(node));
    }

    _setupDragBehavior() {
        return d3.drag()
            .clickDistance(CLICK_THRESHOLD)
            .on('start', (event, node) => {
                if (!event.active) {
                    this.simulation.alphaTarget(0.2).restart();
                }

                node.fx = node.x;
                node.fy = node.y;
            })
            .on('drag', (event, node) => {
                node.fx = event.x;
                node.fy = event.y;
            })
            .on('end', (event, node) => {
                if (!event.active) {
                    this.simulation.alphaTarget(0);
                }

                node.fx = null;
                node.fy = null;
            });
    }

    async _handleNodeClick(event, node) {
        if (event.defaultPrevented || this.interactionLocked) {
            return;
        }

        event.stopPropagation();

        if (this.onNodeClick) {
            this.onNodeClick(node);
        }

        if (node.expanded) {
            this._collapseExpandedNode(node);
            return;
        }

        await this._expandCollapsedNode(node);
    }

    _updateVisualization() {
        this._refreshGraphElements();

        this.simulation.nodes(this.graphData.nodes);
        this.simulation.force('link').links(this.graphData.links);
        this.simulation.alpha(0.3).restart();
    }

    async _fetchRelationData(artistId) {
        try {
            return await requestJson(`/api/relationdata/${artistId}`, {
                errorPrefix: 'Retrieving relation data',
            });
        } catch (error) {
            console.error('Failed to fetch relation data:', error);
            return {};
        }
    }

    async _fetchRelationDataBatch(ids) {
        try {
            return await requestJson('/api/relationdata/batch', {
                errorPrefix: 'Batch relation data fetch',
                fetchOptions: {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids }),
                },
            });
        } catch (error) {
            console.error('Failed to fetch batch relation data:', error);
            return {};
        }
    }

    async _loadRelationDataForIds(ids) {
        if (ids.length === 0) {
            return;
        }

        const batchData = await this._fetchRelationDataBatch(ids);

        for (const [id, data] of Object.entries(batchData)) {
            if (hasUsableRelationData(data)) {
                this.relationData[id] = data;
            }
        }
    }

    _getRelatedArtistsForNode(nodeId) {
        return getSimilarArtists(this.relationData[nodeId]);
    }

    _getArtistData(nodeId) {
        return getPrimaryArtist(this.relationData[nodeId]);
    }

    _getTooltipElements() {
        const tooltip = document.getElementById('tooltip');
        const tooltipBackground = document.getElementById('tooltipBackground');
        const artistLink = document.getElementById('artistlink');
        const artistNameLabel = document.getElementById('artistName');
        const genresLabel = document.getElementById('genres');
        const topTracksContainer = document.getElementById('topTracksContainer');

        if (!tooltip || !tooltipBackground || !artistLink || !artistNameLabel || !genresLabel || !topTracksContainer) {
            return null;
        }

        return {
            tooltip,
            tooltipBackground,
            artistLink,
            artistNameLabel,
            genresLabel,
            topTracksContainer,
        };
    }

    _renderTopTracks(nodeId, container) {
        const topTracks = getTopSongs(this.relationData[nodeId]);
        const visibleTracks = topTracks.slice(0, 5);

        for (const track of visibleTracks) {
            container.appendChild(this._createTrackRow(track));
        }
    }

    _createTrackRow(track) {
        const previewUrl = track.attributes.previews[0].url || '#';
        const trackWrapper = document.createElement('div');
        const nameElement = document.createElement('div');
        const playButton = this._createTrackPlayButton(previewUrl);

        trackWrapper.className = 'flex items-center space-x-2';

        nameElement.textContent = track.attributes.name;
        nameElement.className = 'text-xs sm:text-sm font-inter font-light tracking-tight text-neutral-50 truncate max-w-50';

        trackWrapper.appendChild(playButton);
        trackWrapper.appendChild(nameElement);

        return trackWrapper;
    }

    _createTrackPlayButton(previewUrl) {
        const playButton = document.createElement('button');

        setPlayButtonIcon(playButton);
        playButton.className = 'text-neutral-200 hover:text-green-400 text-sm focus:outline-none cursor-pointer transition-colors';
        playButton.addEventListener('click', () => {
            this._toggleTrackPreview(previewUrl, playButton);
        });

        return playButton;
    }

    _toggleTrackPreview(previewUrl, playButton) {
        if (this.currentAudio && this.currentAudio.src !== previewUrl) {
            this.currentAudio.pause();
            setPlayButtonIcon(this.currentPlayButton);
            this.currentAudio = null;
            this.currentPlayButton = null;
        }

        if (this.currentAudio && this.currentAudio.src === previewUrl && !this.currentAudio.paused) {
            this.currentAudio.pause();
            setPlayButtonIcon(playButton);
            return;
        }

        if (this.currentAudio && this.currentAudio.src === previewUrl && this.currentAudio.paused) {
            this.currentAudio.play().catch(console.error);
            setPauseButtonIcon(playButton);
            this.currentPlayButton = playButton;
            return;
        }

        this.currentAudio = new Audio(previewUrl);
        this.currentAudio.addEventListener('ended', () => {
            setPlayButtonIcon(playButton);
            this.currentAudio = null;
            this.currentPlayButton = null;
        });

        this.currentAudio.play().catch(console.error);
        setPauseButtonIcon(playButton);
        this.currentPlayButton = playButton;
    }

    _resetAudioState() {
        if (this.currentAudio) {
            this.currentAudio.pause();
            this.currentAudio = null;
        }

        if (this.currentPlayButton) {
            setPlayButtonIcon(this.currentPlayButton);
            this.currentPlayButton = null;
        }
    }

    _createGraphLayers() {
        this.graphGroup.selectAll('.links').remove();
        this.graphGroup.selectAll('.nodes').remove();
        this.graphGroup.selectAll('.labels').remove();

        this.linkLayer = this.graphGroup.append('g').attr('class', 'links');
        this.nodeLayer = this.graphGroup.append('g').attr('class', 'nodes');
        this.labelLayer = this.graphGroup.append('g').attr('class', 'labels');
    }

    _refreshGraphElements() {
        this._refreshLinkElements();
        this._refreshNodeElements();
        this._refreshLabelElements();
    }

    _refreshLinkElements() {
        const linkSelection = this.linkLayer
            .selectAll('line')
            .data(this.graphData.links, (link) => this._getLinkSelectionKey(link));

        linkSelection.exit().remove();

        const newLinks = linkSelection.enter()
            .append('line')
            .attr('stroke', LINK_STROKE_COLOR)
            .attr('stroke-width', 1)
            .attr('stroke-opacity', 0.6);

        this.linkElements = newLinks.merge(linkSelection);
    }

    _refreshNodeElements() {
        const nodeSelection = this.nodeLayer
            .selectAll('circle')
            .data(this.graphData.nodes, (node) => node.id);

        nodeSelection.exit().remove();

        const newNodes = nodeSelection.enter()
            .append('circle')
            .attr('r', getNodeRadius)
            .attr('fill', (node) => `url(#${this._createImagePattern(node, getNodeRadius(node))})`)
            .call(this._setupDragBehavior())
            .on('click', (event, node) => this._handleNodeClick(event, node))
            .on('mouseover', (event, node) => {
                if (node.id in this.relationData) {
                    this._showTooltip(node);
                }
            });

        this.nodeElements = newNodes.merge(nodeSelection);
        this.nodeElements
            .attr('stroke', (node) => this._getNodeStrokeColor(node))
            .attr('stroke-width', (node) => this._getNodeStrokeWidth(node))
            .style('cursor', (node) => this._getNodeCursor(node));
    }

    _refreshLabelElements() {
        const labelSelection = this.labelLayer
            .selectAll('text')
            .data(this.graphData.nodes, (node) => node.id);

        labelSelection.exit().remove();

        const newLabels = labelSelection.enter()
            .append('text')
            .attr('class', LABEL_CLASS_NAME)
            .attr('text-anchor', 'middle')
            .attr('dy', getLabelOffset)
            .text((node) => node.name)
            .attr('font-size', '8px')
            .attr('fill', LABEL_FILL_COLOR)
            .style('pointer-events', 'none');

        this.labelElements = newLabels.merge(labelSelection);
    }

    _createSimulation() {
        this.simulation = d3.forceSimulation()
            .nodes(this.graphData.nodes)
            .force('link', d3.forceLink(this.graphData.links).id((node) => node.id).distance(80))
            .force('charge', d3.forceManyBody().strength(-200))
            .force('center', d3.forceCenter(this.width / 2, this.height / 2))
            .alphaDecay(0.01)
            .on('tick', () => this._tick());
    }

    _collapseExpandedNode(node) {
        this.collapseNode(node);
        node.expanded = false;
        this._updateVisualization();

        if (this.onNodeCollapse) {
            this.onNodeCollapse(node);
        }
    }

    async _expandCollapsedNode(node) {
        node.expanded = true;
        this.simulation.stop();

        const added = await this.extendGraph(node.id);

        if (added) {
            this._updateVisualization();

            if (this.onNodeExpand) {
                this.onNodeExpand(node);
            }

            return;
        }

        node.expanded = false;
    }

    _getLinkNodeIds(link) {
        return {
            sourceId: getNodeId(link.source),
            targetId: getNodeId(link.target),
        };
    }

    _getLinkSelectionKey(link) {
        const { sourceId, targetId } = this._getLinkNodeIds(link);
        return buildLinkKey(sourceId, targetId);
    }

    _isParentNeighborLink(link, parentId, neighborIds) {
        const { sourceId, targetId } = this._getLinkNodeIds(link);

        return (sourceId === parentId && neighborIds.has(targetId))
            || (targetId === parentId && neighborIds.has(sourceId));
    }

    _isNeighborAnchored(neighborId, parentId, neighborIds) {
        return this.graphData.links.some((link) => {
            const { sourceId, targetId } = this._getLinkNodeIds(link);

            if (sourceId !== neighborId && targetId !== neighborId) {
                return false;
            }

            const otherNodeId = sourceId === neighborId ? targetId : sourceId;
            return otherNodeId !== parentId && !neighborIds.has(otherNodeId);
        });
    }

    _removeLinkKeys(sourceId, targetId) {
        this.linkSet.delete(buildLinkKey(sourceId, targetId));
        this.linkSet.delete(buildLinkKey(targetId, sourceId));
    }

    _removeNodeIfOrphaned(nodeId) {
        if (!this.nodeMap.has(nodeId)) {
            return;
        }

        if (this._nodeHasConnections(nodeId)) {
            return;
        }

        const node = this.nodeMap.get(nodeId);

        if (node.expanded) {
            this.collapseNode(node);
        }

        this.nodeMap.delete(nodeId);
        this.graphData.nodes = this.graphData.nodes.filter((graphNode) => graphNode.id !== nodeId);
    }

    _nodeHasConnections(nodeId) {
        return this.graphData.links.some((link) => {
            const { sourceId, targetId } = this._getLinkNodeIds(link);
            return sourceId === nodeId || targetId === nodeId;
        });
    }

    _buildAdjacencyMap() {
        const adjacency = new Map();

        for (const link of this.graphData.links) {
            const { sourceId, targetId } = this._getLinkNodeIds(link);

            if (!adjacency.has(sourceId)) {
                adjacency.set(sourceId, new Set());
            }

            if (!adjacency.has(targetId)) {
                adjacency.set(targetId, new Set());
            }

            adjacency.get(sourceId).add(targetId);
            adjacency.get(targetId).add(sourceId);
        }

        return adjacency;
    }

    _buildPathFromPreviousMap(previous, targetId) {
        const pathIds = [targetId];
        let currentId = targetId;

        while (previous.has(currentId)) {
            currentId = previous.get(currentId);
            pathIds.push(currentId);
        }

        pathIds.reverse();

        return pathIds
            .map((id) => this.nodeMap.get(id))
            .filter(Boolean);
    }

    _getNodeStrokeColor(node) {
        if (node.expanded) {
            return EXPANDED_NODE_STROKE_COLOR;
        }

        return node.id in this.relationData ? AVAILABLE_NODE_STROKE_COLOR : 'none';
    }

    _getNodeStrokeWidth(node) {
        return node.id in this.relationData ? 0.5 : 0;
    }

    _getNodeCursor(node) {
        return node.id in this.relationData ? 'pointer' : 'default';
    }
}

export async function fetchSearchResults(prefix) {
    try {
        return await requestJson(`/api/search/${prefix}`, {
            errorPrefix: 'Retrieving search results',
        });
    } catch (error) {
        console.error('Failed to fetch search results:', error);
        return {};
    }
}

function hideResults(resultsEl) {
    resultsEl.classList.add('hidden');
}

function clearResults(resultsEl) {
    resultsEl.innerHTML = '';
}

function createArtistResultItem(entry, inputEl, resultsEl, itemClassName, onSelect) {
    const item = document.createElement('div');

    item.textContent = entry.name;
    item.className = itemClassName;
    item.addEventListener('click', () => {
        inputEl.value = entry.name;
        inputEl.dataset.id = entry.id;
        hideResults(resultsEl);

        if (onSelect) {
            onSelect(entry);
        }

        inputEl.focus();
    });

    return item;
}

export async function displayArtistResults({
    query,
    limit = SEARCH_RESULT_LIMIT,
    inputEl,
    resultsEl,
    itemClassName = 'py-2 px-4 text-neutral-400 hover:bg-white/10 cursor-pointer',
    onSelect,
}) {
    if (!inputEl || !resultsEl) {
        return;
    }

    inputEl.dataset.id = '';
    clearResults(resultsEl);

    if (!query) {
        hideResults(resultsEl);
        return;
    }

    const results = await fetchSearchResults(query);
    const entries = Object.values(results).filter(Boolean).slice(0, limit);

    if (entries.length === 0) {
        hideResults(resultsEl);
        return;
    }

    for (const entry of entries) {
        const item = createArtistResultItem(entry, inputEl, resultsEl, itemClassName, onSelect);
        resultsEl.appendChild(item);
    }

    resultsEl.classList.remove('hidden');
}

export async function initializeGraph(svgSelector, options) {
    return new ArtistNetworkGraph(svgSelector, options);
}

function hideEnterButton(enterButton) {
    if (enterButton && !enterButton.classList.contains('hidden')) {
        enterButton.classList.add('hidden');
    }
}

export function setupSearchListeners({
    graph,
    searchInput,
    resultsContainer,
    enterButton,
    onSelect,
    itemClassName,
}) {
    if (!searchInput || !resultsContainer) {
        return;
    }

    let debounceTimer;

    searchInput.addEventListener('input', (event) => {
        const query = event.target.value.trim();

        clearTimeout(debounceTimer);

        if (!query) {
            searchInput.classList.remove('animate-pulse');
            hideResults(resultsContainer);
            hideEnterButton(enterButton);
            return;
        }

        searchInput.classList.add('animate-pulse');

        debounceTimer = setTimeout(async () => {
            try {
                await displayArtistResults({
                    query,
                    limit: SEARCH_RESULT_LIMIT,
                    inputEl: searchInput,
                    resultsEl: resultsContainer,
                    itemClassName,
                    onSelect: (entry) => {
                        if (onSelect) {
                            onSelect(entry, graph);
                        }
                    },
                });
            } finally {
                searchInput.classList.remove('animate-pulse');
            }
        }, SEARCH_DEBOUNCE_MS);
    });
}

export function setupPopStateHandler(overlay) {
    window.addEventListener('popstate', () => {
        overlay.classList.remove('hidden');
        history.pushState({}, '', '/');
    });
}

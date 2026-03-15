const heapInsert = (heap, item) => {
	heap.push(item);
	let i = heap.length - 1;
	while (i > 0) {
		const p = (i - 1) >> 1;
		if (heap[p].index >= item.index) break;
		heap[i] = heap[p];
		i = p;
	}
	heap[i] = item;
};

const heapRemoveMax = (heap) => {
	if (heap.length === 1) return heap.pop();
	const max = heap[0];
	const end = heap.pop();
	let i = 0;
	if (heap.length) {
		heap[0] = end;
		while (true) {
			let l = 2 * i + 1,
				r = 2 * i + 2,
				largest = i;
			if (l < heap.length && heap[l].index > heap[largest].index) largest = l;
			if (r < heap.length && heap[r].index > heap[largest].index) largest = r;
			if (largest === i) break;
			[heap[i], heap[largest]] = [heap[largest], heap[i]];
			i = largest;
		}
	}
	return max;
};

const heapPushSelect = (heap, item, k = 5) => {
	if (heap.length < k) {
		heapInsert(heap, item);
	} else if (item.index < heap[0].index) {
		heapRemoveMax(heap);
		heapInsert(heap, item);
	}
};

module.exports = {
	heapInsert,
	heapRemoveMax,
	heapPushSelect
};
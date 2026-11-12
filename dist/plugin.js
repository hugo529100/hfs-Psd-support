'use strict';

exports.description = "PSD cached server-side support for HFS - converts PSD composite image to JPG on the fly for preview with Show and generates thumbnails"
exports.version = 1.1
exports.apiRequired = 12.6
exports.repo = "Hug3O/PSD-Support"
exports.preview = []

exports.config = {
    jpegQuality: {
        title: 'JPEG Quality',
        type: 'number',
        defaultValue: 95,
        min: 10,
        max: 100,
        step: 5,
        helperText: 'Quality of the converted JPEG images (10-100). Requires plugin restart to apply changes.',
        frontend: true
    },
    cacheAround: {
        title: 'Preconvert Files (Around)',
        type: 'number',
        defaultValue: 16,
        min: 0,
        max: 100,
        helperText: 'Number of PSD files to preconvert before and after the current one (0 to disable)',
        frontend: true
    },
    cacheTTL: {
        title: 'Cache Time To Live (hours)',
        type: 'number',
        defaultValue: 24,
        min: 1,
        max: 720,
        helperText: 'Time in hours after which cache files will be automatically deleted (cleaning interval: one hour)',
        frontend: true
    },
    backgroundWorkersCount: {
        title: 'Background Workers Count',
        type: 'number',
        defaultValue: 1,
        min: 1,
        max: 8,
        helperText: 'Number of background workers for parallel preconversion (1-8). Workers only read files; PSD decoding is done on the main thread.',
        frontend: true
    },
    generateThumbnails: {
        title: 'Generate Thumbnails',
        type: 'boolean',
        defaultValue: true,
        helperText: 'Generate 800px thumbnails via Sharp.',
        frontend: true
    }
};

let path, fs, util, crypto, Worker, vm;
let PsdReader;
let cache = new Map();
let workerPool = [];
let inProgress = new Set();
let pendingBackgroundTasks = new Set();
let cleanupInterval;
let isUnloading = false;
let cacheDir;
let thumbCacheDir;

let jpegQuality = 0.95;
let cacheAround = 16;
let cacheTTL = 24 * 60 * 60 * 1000;
let backgroundWorkersCount = 1;
let generateThumbnails = true;

let isInitializing = true;

exports.init = function (api) {
    path = api.require('path');
    fs = api.require('fs');
    util = api.require('util');
    crypto = api.require('crypto');
    Worker = api.require('worker_threads').Worker;
    vm = api.require('vm');

    // psd-reader 是浏览器风格脚本：先补 navigator（仅用于 guessGamma）
    if (typeof globalThis.navigator === 'undefined') {
        globalThis.navigator = { userAgent: 'node' };
    }

    // 用 vm 在全局上下文执行 psd-reader.min.js，
    // 让它的 function PsdReader(...) 挂到 globalThis.PsdReader 上
    try {
        const vendorPath = path.join(__dirname, 'vendor', 'psd-reader.min.js');
        const code = fs.readFileSync(vendorPath, 'utf8');
        vm.runInThisContext(code, { filename: vendorPath });

        PsdReader = globalThis.PsdReader;
        if (typeof PsdReader !== 'function') {
            throw new Error('PsdReader global not found after executing vendor script');
        }
    } catch (e) {
        api.log('FATAL: failed to load psd-reader.min.js. Place it in the plugin vendor/ folder.', e);
        throw e;
    }

    const pluginDir = __dirname;
    cacheDir = path.join(pluginDir, 'cache');
    thumbCacheDir = path.join(pluginDir, 'thumb-cache');
    const workerPath = path.join(pluginDir, 'worker.js');

    if (!fs.existsSync(thumbCacheDir)) {
        fs.mkdirSync(thumbCacheDir, { recursive: true });
    }

    const initialConfig = api.getConfig();
    updateConfig(initialConfig);
    jpegQuality = (initialConfig.jpegQuality || 95) / 100;

    api.subscribeConfig(
        ['cacheAround', 'cacheTTL', 'backgroundWorkersCount', 'generateThumbnails'],
        (newValues) => {
            if (isInitializing) {
                isInitializing = false;
                return;
            }
            const updatedConfig = { ...initialConfig, ...newValues };
            updateConfig(updatedConfig);

            if (newValues.backgroundWorkersCount !== undefined) {
                restartWorkers().catch(error => {
                    api.log('Error restarting workers:', error);
                });
            }
        }
    );

    function updateConfig(config) {
        cacheAround = typeof config.cacheAround !== 'undefined' ? config.cacheAround : 16;
        cacheTTL = (typeof config.cacheTTL !== 'undefined' ? config.cacheTTL : 24) * 60 * 60 * 1000;
        backgroundWorkersCount = typeof config.backgroundWorkersCount !== 'undefined'
            ? Math.max(1, Math.min(8, config.backgroundWorkersCount)) : 1;
        generateThumbnails = typeof config.generateThumbnails !== 'undefined' ? config.generateThumbnails : true;
    }

    function getPathHash(realPath) {
        return crypto.createHash('md5').update(realPath).digest('hex');
    }

    function getCacheBaseName(realPath) {
        const base = path.basename(realPath, path.extname(realPath))
            .replace(/[^\w.-]+/g, '_')
            .slice(0, 80);
        const hash8 = getPathHash(realPath).slice(0, 8);
        return `${base}_${hash8}`;
    }

    function getThumbCachePath(realPath) {
        return path.join(thumbCacheDir, `${getCacheBaseName(realPath)}_thumb.jpg`);
    }

    function getConvertCachePath(realPath) {
        return path.join(cacheDir, `${getCacheBaseName(realPath)}.jpg`);
    }

    /**
     * 用 psd-reader 读取 PSD 合成图，再交给 Sharp 以 raw 输入编码为 JPEG。
     */
    async function convertPsdBuffer(psdBuffer, quality) {
        const arrayBuffer = psdBuffer.buffer.slice(
            psdBuffer.byteOffset,
            psdBuffer.byteOffset + psdBuffer.byteLength
        );

        const psd = await new Promise((resolve, reject) => {
            try {
                new PsdReader({
                    buffer: arrayBuffer,
                    gamma: 1,
                    dematte: true,
                    onLoad: function () {
                        // psd-reader 用 bind(this) 绑定回调，this 即实例
                        resolve(this);
                    },
                    onError: function (err) {
                        reject(new Error(
                            'PSD parse error: ' + (err && err.message ? err.message : String(err))
                        ));
                    }
                });
            } catch (e) {
                reject(new Error('PSD reader init failed: ' + e.message));
            }
        });

        if (!psd || !psd.rgba) {
            throw new Error('PSD: no composite image data (file must be saved with Compatibility Mode)');
        }

        const width = psd.info.width;
        const height = psd.info.height;
        if (!width || !height) {
            throw new Error('PSD: invalid dimensions');
        }

        const rawOptions = { raw: { width, height, channels: 4 } };
        const sharpResults = api.customApiCall('sharp', psd.rgba, rawOptions);
        if (!sharpResults || sharpResults.length === 0) {
            throw new Error('sharp plugin not available');
        }
        const sharp = sharpResults[0];
        return await sharp
            .jpeg({ quality: Math.round(quality * 100) })
            .toBuffer();
    }

    async function generateThumbnail(jpgBuffer, filePath) {
        if (!generateThumbnails) return null;
        try {
            const sharpResults = api.customApiCall('sharp', jpgBuffer);
            if (!sharpResults || sharpResults.length === 0) return null;

            const sharp = sharpResults[0];
            const thumbBuffer = await sharp
                .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toBuffer();

            const thumbPath = getThumbCachePath(filePath);
            await fs.promises.writeFile(thumbPath, thumbBuffer);
            return thumbBuffer;
        } catch (error) {
            api.log('Error generating thumbnail:', error);
            return null;
        }
    }

    async function checkThumbCache(realPath) {
        try {
            const thumbPath = getThumbCachePath(realPath);
            if (!fs.existsSync(thumbPath)) return null;

            const thumbStats = await fs.promises.stat(thumbPath);
            const fileStats = await fs.promises.stat(realPath);

            if (fileStats.mtimeMs > thumbStats.mtimeMs) {
                fs.unlinkSync(thumbPath);
                return null;
            }
            return await fs.promises.readFile(thumbPath);
        } catch (error) {
            api.log(`Error checking thumbnail cache for ${realPath}:`, error);
            return null;
        }
    }

    async function restartWorkers() {
        if (isUnloading) return;
        await stopWorkers();

        immediateQueue.length = 0;
        backgroundQueue.length = 0;
        inProgress.clear();
        pendingBackgroundTasks.clear();

        workerPool = [];
        workerPool.push(createWorker(1, 'immediate'));
        for (let i = 2; i <= backgroundWorkersCount + 1; i++) {
            workerPool.push(createWorker(i, 'background'));
        }
    }

    async function stopWorkers() {
        if (workerPool.length === 0) return;

        const terminationPromises = workerPool.map(worker => {
            return new Promise(resolve => {
                if (worker && !worker.isTerminating) {
                    worker.isTerminating = true;
                    try {
                        worker.postMessage({ type: 'shutdown' });
                    } catch (error) {
                        api.log(`Error sending shutdown to worker ${worker.id}:`, error);
                    }
                    worker.removeAllListeners('message');
                    worker.removeAllListeners('error');
                    worker.once('exit', () => resolve());
                    setTimeout(() => {
                        if (worker.exitCode === null) worker.terminate();
                    }, 1000);
                } else {
                    resolve();
                }
            });
        });

        await Promise.race([
            Promise.all(terminationPromises),
            new Promise(resolve => setTimeout(resolve, 3000))
        ]);

        workerPool = [];
    }

    for (const dir of [cacheDir, thumbCacheDir]) {
        if (fs.existsSync(dir)) {
            try {
                for (const file of fs.readdirSync(dir)) {
                    fs.unlinkSync(path.join(dir, file));
                }
            } catch (error) {
                api.log(`Error clearing cache ${dir} on startup:`, error);
            }
        } else {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    const cleanupOldCache = async () => {
        if (isUnloading) return;
        try {
            const now = Date.now();
            for (const dir of [cacheDir, thumbCacheDir]) {
                if (!fs.existsSync(dir)) continue;
                for (const file of fs.readdirSync(dir)) {
                    const filePath = path.join(dir, file);
                    try {
                        const stats = fs.statSync(filePath);
                        if (now - stats.mtimeMs > cacheTTL) {
                            fs.unlinkSync(filePath);
                            for (const [key, value] of cache.entries()) {
                                if (value.path === filePath) {
                                    cache.delete(key);
                                    break;
                                }
                            }
                        }
                    } catch (error) {
                        api.log(`Error processing cache file ${file}:`, error);
                    }
                }
            }
            await restartWorkers();
        } catch (error) {
            api.log('Error in cache cleanup:', error);
        }
    };

    cleanupInterval = setInterval(() => {
        cleanupOldCache().catch(error => {
            api.log('Error during scheduled cleanup:', error);
        });
    }, 60 * 60 * 1000);

    let lastRequestedFile = null;

    const createWorker = (id, role) => {
        const worker = new Worker(workerPath);
        worker.setMaxListeners(20);
        worker.isBusy = false;
        worker.id = id;
        worker.role = role;
        worker.isTerminating = false;

        worker.on('message', async (message) => {
            if (worker.isTerminating) return;

            worker.isBusy = false;
            if (message.filePath) inProgress.delete(message.filePath);

            if (message.success) {
                try {
                    // 结构化克隆后 Buffer → Uint8Array，重新包成 Buffer
                    const rawBuffer = Buffer.from(
                        message.buffer.buffer,
                        message.buffer.byteOffset,
                        message.buffer.byteLength
                    );
                    const jpgBuffer = await convertPsdBuffer(rawBuffer, jpegQuality);
                    await cacheConversion(message.filePath, jpgBuffer);

                    if (generateThumbnails) {
                        try {
                            await generateThumbnail(jpgBuffer, message.filePath);
                        } catch (thumbError) {
                            api.log('Thumbnail generation failed:', thumbError);
                        }
                    }

                    if (worker.role === 'immediate' && lastRequestedFile === message.filePath) {
                        const parentPath = path.dirname(message.filePath);
                        preconvertNeighbors(message.filePath, parentPath);
                    }
                } catch (convError) {
                    api.log(`Conversion error for ${message.filePath}:`, convError);
                }
            } else if (message.error) {
                api.log(`Worker ${worker.id} (${worker.role}) read error for ${message.filePath}:`, message.error);
            }

            processNextTask(worker);
        });

        worker.on('error', (error) => {
            if (worker.isTerminating) return;
            api.log(`Worker ${worker.id} (${worker.role}) error:`, error);
            worker.isBusy = false;
            if (worker.currentTask) {
                inProgress.delete(worker.currentTask.filePath);
                worker.currentTask = null;
            }
            processNextTask(worker);
        });

        worker.on('exit', (code) => {
            if (code !== 0 && !isUnloading && !worker.isTerminating) {
                const index = workerPool.findIndex(w => w.id === worker.id);
                if (index !== -1) {
                    workerPool[index] = createWorker(worker.id, worker.role);
                }
            }
        });

        return worker;
    };

    workerPool.push(createWorker(1, 'immediate'));
    for (let i = 2; i <= backgroundWorkersCount + 1; i++) {
        workerPool.push(createWorker(i, 'background'));
    }

    const immediateQueue = [];
    const backgroundQueue = [];

    const processNextTask = (worker) => {
        if (worker.isBusy || worker.isTerminating) return;

        let queue = worker.role === 'immediate' ? immediateQueue : backgroundQueue;
        if (queue.length === 0) return;

        const task = queue.shift();
        if (worker.role === 'background') {
            pendingBackgroundTasks.delete(task.filePath);
        }

        if (inProgress.has(task.filePath)) {
            processNextTask(worker);
            return;
        }

        worker.isBusy = true;
        worker.currentTask = task;
        inProgress.add(task.filePath);

        if (!worker.isTerminating) {
            worker.postMessage({ type: 'read', filePath: task.filePath });
        }
    };

    const addConversionTask = async (filePath, priority = false) => {
        if (isUnloading) return;
        if (inProgress.has(filePath)) return;

        if (priority) {
            lastRequestedFile = filePath;
            immediateQueue.length = 0;
            immediateQueue.push({ filePath, quality: jpegQuality });
            const immediateWorker = workerPool.find(w => w.role === 'immediate' && !w.isBusy && !w.isTerminating);
            if (immediateWorker) processNextTask(immediateWorker);
        } else {
            if (pendingBackgroundTasks.has(filePath)) return;
            backgroundQueue.push({ filePath, quality: jpegQuality });
            pendingBackgroundTasks.add(filePath);

            const backgroundWorkers = workerPool.filter(w =>
                w.role === 'background' && !w.isBusy && !w.isTerminating
            );
            backgroundWorkers.forEach(worker => processNextTask(worker));
        }
    };

    async function cacheConversion(realPath, outputBuffer) {
        try {
            if (!fs.existsSync(cacheDir)) {
                fs.mkdirSync(cacheDir, { recursive: true });
            }
            const cachePath = getConvertCachePath(realPath);
            await fs.promises.writeFile(cachePath, outputBuffer);
            cache.set(realPath, { path: cachePath, timestamp: Date.now() });
        } catch (error) {
            api.log('Error caching conversion:', error);
        }
    }

    async function checkCache(realPath) {
        try {
            if (!cache.has(realPath)) return null;

            const cacheInfo = cache.get(realPath);
            const cacheStats = await fs.promises.stat(cacheInfo.path);
            const fileStats = await fs.promises.stat(realPath);

            if (fileStats.mtimeMs > cacheStats.mtimeMs) {
                fs.unlinkSync(cacheInfo.path);
                cache.delete(realPath);
                return null;
            }
            return await fs.promises.readFile(cacheInfo.path);
        } catch (error) {
            api.log(`Error checking cache for ${realPath}:`, error);
            return null;
        }
    }

    async function preconvertNeighbors(realPath, parentPath) {
        if (cacheAround === 0) return;

        backgroundQueue.length = 0;
        pendingBackgroundTasks.clear();

        try {
            const files = await fs.promises.readdir(parentPath);
            const psdFiles = files.filter(f =>
                f.toLowerCase().endsWith('.psd')
            ).sort();

            const currentIndex = psdFiles.findIndex(f =>
                path.join(parentPath, f) === realPath
            );
            if (currentIndex === -1) return;

            const start = Math.max(0, currentIndex - cacheAround);
            const end = Math.min(psdFiles.length - 1, currentIndex + cacheAround);

            const filesToConvert = [];
            for (let i = currentIndex + 1; i <= end; i++) {
                filesToConvert.push(path.join(parentPath, psdFiles[i]));
            }
            for (let i = currentIndex - 1; i >= start; i--) {
                filesToConvert.push(path.join(parentPath, psdFiles[i]));
            }

            if (filesToConvert.length > 0) {
                setTimeout(() => {
                    if (isUnloading) return;
                    filesToConvert.forEach(filePath => {
                        checkCache(filePath).then(cached => {
                            if (!cached && !isUnloading) {
                                addConversionTask(filePath, false);
                            }
                        });
                    });
                }, 500);
            }
        } catch (error) {
            api.log('Error in preconvertNeighbors:', error);
        }
    }

    setTimeout(() => { isInitializing = false; }, 100);

    const isPsd = (url) => url.endsWith('.psd');

    return {
        middleware: ctx => async () => {
            const url = ctx.path.toLowerCase();

            // ===== Show 预览：完整转换 =====
            if (isPsd(url) && ctx.query.convert === 'psd') {
                try {
                    if (!ctx.state.vfsNode) {
                        ctx.status = 404;
                        return ctx.stop();
                    }
                    const realPath = ctx.state.vfsNode.source;
                    if (!realPath) {
                        ctx.status = 404;
                        return ctx.stop();
                    }

                    const cachedData = await checkCache(realPath);
                    if (cachedData) {
                        ctx.type = 'image/jpeg';
                        ctx.set('Cache-Control', 'public, max-age=3600');
                        ctx.body = cachedData;
                        preconvertNeighbors(realPath, path.dirname(realPath));
                        return ctx.stop();
                    }

                    addConversionTask(realPath, true);

                    const waitForConversion = async (filePath, maxWait = 30000) => {
                        const startTime = Date.now();
                        while (Date.now() - startTime < maxWait) {
                            const cached = await checkCache(filePath);
                            if (cached) return cached;
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                        return null;
                    };

                    const result = await waitForConversion(realPath);
                    if (result) {
                        ctx.type = 'image/jpeg';
                        ctx.set('Cache-Control', 'public, max-age=3600');
                        ctx.body = result;
                        preconvertNeighbors(realPath, path.dirname(realPath));
                    } else {
                        ctx.status = 202;
                        ctx.body = 'Conversion in progress, please wait and refresh';
                    }
                    return ctx.stop();
                } catch (error) {
                    api.log('Error processing conversion request:', error);
                    ctx.status = 500;
                    return ctx.stop();
                }
            }

            // ===== 缩略图 =====
            if (isPsd(url) && ctx.query.get === 'thumbpsd') {
                try {
                    if (!ctx.state.vfsNode) {
                        ctx.status = 404;
                        return ctx.stop();
                    }
                    const realPath = ctx.state.vfsNode.source;
                    if (!realPath) {
                        ctx.status = 404;
                        return ctx.stop();
                    }

                    if (generateThumbnails) {
                        const thumbData = await checkThumbCache(realPath);
                        if (thumbData) {
                            ctx.type = 'image/jpeg';
                            ctx.set('Cache-Control', 'public, max-age=3600');
                            ctx.body = thumbData;
                            return ctx.stop();
                        }

                        const cachedData = await checkCache(realPath);
                        if (cachedData) {
                            const t = await generateThumbnail(cachedData, realPath);
                            if (t) {
                                ctx.type = 'image/jpeg';
                                ctx.set('Cache-Control', 'public, max-age=3600');
                                ctx.body = t;
                                return ctx.stop();
                            }
                        }

                        addConversionTask(realPath, true);

                        const waitForThumb = async (filePath, maxWait = 30000) => {
                            const startTime = Date.now();
                            while (Date.now() - startTime < maxWait) {
                                const t = await checkThumbCache(filePath);
                                if (t) return t;
                                await new Promise(resolve => setTimeout(resolve, 500));
                            }
                            return null;
                        };

                        const t = await waitForThumb(realPath);
                        if (t) {
                            ctx.type = 'image/jpeg';
                            ctx.set('Cache-Control', 'public, max-age=3600');
                            ctx.body = t;
                            return ctx.stop();
                        }
                    }

                    // 没有生成缩略图；返回 404 让前端回落默认图标
                    ctx.status = 404;
                    return ctx.stop();
                } catch (error) {
                    api.log('Error processing thumbnail request:', error);
                    ctx.status = 500;
                    return ctx.stop();
                }
            }
        },

        frontend_js: 'frontend.js',

        unload: () => {
            isUnloading = true;
            isInitializing = false;

            if (cleanupInterval) clearInterval(cleanupInterval);

            try {
                [cacheDir, thumbCacheDir].forEach(dir => {
                    if (fs.existsSync(dir)) {
                        for (const file of fs.readdirSync(dir)) {
                            try {
                                fs.unlinkSync(path.join(dir, file));
                            } catch (error) {
                                api.log(`Error deleting cache file ${file}:`, error);
                            }
                        }
                    }
                });
            } catch (error) {
                api.log('Error clearing cache directories on unload:', error);
            }

            immediateQueue.length = 0;
            backgroundQueue.length = 0;
            inProgress.clear();
            pendingBackgroundTasks.clear();
            cache.clear();

            return stopWorkers().then(() => {});
        }
    };
};
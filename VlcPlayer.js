import fetch from "node-fetch";
import * as path from 'node:path';
import * as url from 'url';
import { promises as fs } from 'node:fs';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const rootPath = path.resolve(__dirname, "../../../../../..");
const VLC_PATH = path.normalize(path.join(rootPath, "client", "resources", "app", "lib", "VideoLAN", "VLC", "vlc.exe"));
const VIDEO_DIR = Config.modules.VlcPlayer.VIDEO_DIR;
const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.m4v'];

export async function init() {
    await Avatar.lang.addPluginPak('VlcPlayer');
}

export async function cron() {}

export async function action(data, callback) {
    try {
        const client = data.client;
        const toClient = data.toClient || data.client;
        const L = await Avatar.lang.getPak('VlcPlayer', data.language);

        const tblActions = {
            playMovie: () => playMovie(data, client, toClient, L),
            stopMovie: () => stopMovie(client, toClient, L, data.action?.silent),
            closeVlc: () => closeVlc(client, toClient, L),
            pauseMovie: () => pauseMovie(client, toClient, L),
            resumeMovie: () => resumeMovie(client, toClient, L),
            vlcVolume: () => vlcVolume(data, client, toClient, L)
        };
        
        info("VlcPlayer:", data.action?.command, "from", client, "to", toClient);
            
        if (tblActions[data.action?.command]) {
            await tblActions[data.action.command]();
        }
        
    } catch (err) {
        if (data.client) Avatar.Speech.end(data.client);
        if (err.message) error(err.message);
    } finally {
        callback();
    }
}

const getVideoFiles = async (dir) => {
    let results = [];
    try {
        const list = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of list) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const subResults = await getVideoFiles(fullPath);
                results = results.concat(subResults);
            } else {
                const ext = path.extname(entry.name).toLowerCase();
                if (VIDEO_EXTENSIONS.includes(ext)) {
                    const cleanTitle = path.basename(entry.name, ext).replace(/^[0-9\s\-_]+/, '');
                    results.push({
                        name: entry.name,
                        title: cleanTitle,
                        path: fullPath
                    });
                }
            }
        }
    } catch (err) {
       error(`Erreur lors de la lecture du répertoire vidéo [${dir}] : ${err.message}`);
    }
    return results;
};

const vlcCommand = async (toClient, command) => {
    const cfg = Config.modules.VlcPlayer;
    const host = cfg.clients[toClient]?.host;

    if (!host) {
        throw new Error(`Client VLC inconnu : ${toClient}`);
    }
    const targetUrl = `http://${host}:${cfg.port}/requests/status.xml?${command}`;
    const auth = Buffer.from(":" + (cfg.password)).toString("base64");

    const response = await fetch(targetUrl, {
        headers: {
            Authorization: "Basic " + auth
        }
    });
    if (!response.ok) {
        throw new Error(`Erreur VLC : ${response.status}`);
    }
    return response.text();
};

const normalize = (str) => {
    return str
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[-_':,.?!]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
};

const playMovie = async (data, client, toClient, L) => {
    try {
        const sentence = (data.rawSentence || data.action?.sentence || "").toLowerCase();
        const cleanSentence = normalize(sentence);
        
        const extract = {
            serie: data.action?.serie || null,
            saison: data.action?.saison || null,
            episode: data.action?.episode || null
        };

        if (!extract.serie) {
            const matchSaison = sentence.match(/saison\s+(\d+)/i);
            const matchEpisode = sentence.match(/(?:épisode|episode)\s+(\d+)/i);
            
            if (matchSaison) extract.saison = parseInt(matchSaison[1], 10);
            if (matchEpisode) extract.episode = parseInt(matchEpisode[1], 10);

            // Capturer la série même si le mot "série" n'est pas explicite
            const matchSerie = sentence.match(/(?:série|serie)\s+(.*?)(?:\s+saison|\s+épisode|\s+episode|$)/i);
            if (matchSerie) {
                extract.serie = matchSerie[1].trim();
            }
        }

        const videoFiles = await getVideoFiles(VIDEO_DIR);

        if (!videoFiles || videoFiles.length === 0) {
            info("VlcPlayer: Aucun fichier vidéo trouvé dans", VIDEO_DIR);
            return Avatar.speak(L.get("speech.noVideosFound", VIDEO_DIR), client, () => Avatar.Speech.end(client));
        }

        let foundMovie = null;

        if (extract.serie) {
            foundMovie = videoFiles
                .sort((a, b) => b.title.length - a.title.length)
                .find(video => {
                    const file = video.path.toLowerCase();
                    const fileName = path.basename(file);
                    const title = video.title.toLowerCase();
                    const serie = extract.serie.toLowerCase();

                    if (!file.includes(serie) && !title.includes(serie)) return false;

                    if (extract.saison) {
                        const seasonStr = String(extract.saison).padStart(2, '0');
                        const matchesSeason = file.includes(`saison ${seasonStr}`) || 
                                              file.includes(`s${seasonStr}`) || 
                                              file.includes(`saison ${extract.saison}`);
                        if (!matchesSeason) return false;
                    }

                    if (extract.episode) {
                        const epStr = String(extract.episode).padStart(2, '0');
                        const matchesEpisode = fileName.startsWith(epStr) || 
                                               fileName.includes(`e${epStr}`) || 
                                               fileName.includes(`e${extract.episode}`) ||
                                               fileName.includes(`épisode ${extract.episode}`) ||
                                               fileName.includes(`episode ${extract.episode}`);
                        if (!matchesEpisode) return false;
                    }

                    return true;
                });
        } else {
            const stopWords = new Set(["le", "la", "les", "du", "de", "des", "et", "un", "une", "film", "mets", "joue", "regarder"]);
            let highestScore = 0;

            const sortedMovies = videoFiles.sort((a, b) => b.title.length - a.title.length);

            for (const video of sortedMovies) {
                const cleanTitle = normalize(video.title);

                if (cleanSentence.includes(cleanTitle)) {
                    foundMovie = video;
                    break;
                }

                const titleWords = cleanTitle.split(" ").filter(w => w.length > 1 && !stopWords.has(w));
                if (titleWords.length === 0) continue;

                let matchedWords = 0;
                for (const word of titleWords) {
                    if (cleanSentence.includes(word)) {
                        matchedWords++;
                    }
                }

                const score = matchedWords / titleWords.length;

                if (score >= 0.5 && score > highestScore) {
                    highestScore = score;
                    foundMovie = video;
                }
            }
        }

        if (!foundMovie) {
            info("VlcPlayer: Film ou Série non trouvé dans le répertoire vidéo.");
            return Avatar.speak(L.get("speech.unknownMovie", "vidéo"), client, () => Avatar.Speech.end(client));
        }

        await Avatar.stop(toClient);
        await Avatar.runApp("taskkill", toClient, "/F /T /IM brave.exe");
        
        const ready = await ensureVlc(toClient);
        if (!ready) {
            error("Impossible de démarrer VLC");
            if (typeof infoOrange === 'function') infoOrange(L.get("speech.noLaunch"));
            return Avatar.speak(L.get("speech.noLaunch"), client, () => Avatar.Speech.end(client));
        }
        
        Avatar.static.set(VIDEO_DIR, async () => {
            const relativePath = path.relative(VIDEO_DIR, foundMovie.path).replace(/\\/g, '/');
            const serverIp = Config.http.ip;
            const serverPort = Config.http.port;
            
            const videoUrl = `http://${serverIp}:${serverPort}/${encodeURIComponent(relativePath).replace(/%2F/g, '/')}`;

            info(`VlcPlayer: Envoi du flux HTTP à VLC (${toClient}) ->`, videoUrl);

            await vlcCommand(toClient, `command=in_play&input=${encodeURIComponent(videoUrl)}`);
            
            const message = L.get("speech.playMovie", foundMovie.title, toClient);
            info(`VLC lecture : [${foundMovie.title}] sur ${toClient}`);
            
            Avatar.speak(message, client, () => Avatar.Speech.end(client));
        });

    } catch (err) {
        error("Erreur VlcPlayer:", err.message);
        Avatar.speak(L.get("speech.errorApi"), client, () => Avatar.Speech.end(client));
    }
};

const stopMovie = async (client, toClient, L, silent = false) => {
    if (!await isVlcRunning(toClient)) {
        info("VLC - Stop demandé mais VLC n'est pas lancé sur", toClient);
        if (!silent) {
            return Avatar.speak(L.get("speech.vlcNotRunning", toClient), client, () => Avatar.Speech.end(client));
        }
        return Avatar.Speech.end(client);
    }
    await vlcCommand(toClient, "command=pl_stop");
    info("VLC - Stop lecture sur", toClient);
    if (silent) {
        return Avatar.Speech.end(client);
    }
    const message = L.get("speech.stopMovie", toClient);
    Avatar.speak(message, client, () => Avatar.Speech.end(client));
};

const closeVlc = (client, toClient, L) => {
    Avatar.runApp("taskkill", toClient, "/F /IM vlc.exe", () => {
        Avatar.speak(L.get("speech.closeVlc", toClient), client, () => {
            Avatar.Speech.end(client);
        });
    });
    info("VLC - Fermersur", toClient);
};

const pauseMovie = async (client, toClient, L) => {
    if (!await isVlcRunning(toClient)) {
        return Avatar.speak(L.get("speech.vlcNotRunning"), client, () => Avatar.Speech.end(client));
    }
    await vlcCommand(toClient, "command=pl_pause");
    const message = L.get("speech.pauseVlc", client);
    Avatar.speak(message, client, () => Avatar.Speech.end(client));
};

const resumeMovie = async (client, toClient, L) => {
    if (!await isVlcRunning(toClient)) {
        return Avatar.speak(L.get("speech.vlcNotRunning"), client, () => Avatar.Speech.end(client));
    }
    await vlcCommand(toClient, "command=pl_pause"); 
    const message = L.get("speech.resumeVlc", client);
    Avatar.speak(message, client, () => Avatar.Speech.end(client));
};

const vlcVolume = async (data, client, toClient, L) => {
    const sentence = (data.rawSentence || data.action?.sentence || "").toLowerCase();

    if (!sentence) {
        return Avatar.speak(L.get("speech.volumeNoIncludes"), client, () => Avatar.Speech.end(client));
    }

    const match = sentence.match(/(\d{1,3})\s*(%|pour ?cent)?/);
    if (!match) {
        return Avatar.speak(L.get("speech.volumeUnknown"), client, () => Avatar.Speech.end(client));
    }

    const percent = Math.max(0, Math.min(100, parseInt(match[1], 10)));
    const vlcValue = Math.round((percent * 256) / 100);

    await vlcCommand(toClient, `command=volume&val=${vlcValue}`);

    info(L.get("speech.volume", percent));
    Avatar.speak(L.get("speech.volume", percent), client, () => Avatar.Speech.end(client));
};

const setVolume = async (toClient, percent) => {
    const value = Math.round((percent * 256) / 100);
    await vlcCommand(toClient, `command=volume&val=${value}`);
};

const isVlcRunning = async (toClient) => {
    try {
        await vlcCommand(toClient, "command=get_time");
        return true;
    } catch {
        return false;
    }
};

const startVlc = (toClient) => {
    const cfg = Config.modules.VlcPlayer;
    const VLC_ARGS = `--extraintf=http --http-password=${cfg.password} --fullscreen --quiet`;
    Avatar.runApp(VLC_PATH, toClient, VLC_ARGS, false);
};

const waitVlc = async (toClient) => {
    for (let i = 0; i < 10; i++) {
        if (await isVlcRunning(toClient)) return true;
        await new Promise(r => setTimeout(r, 1000));
    }
    return false;
};

const ensureVlc = async (toClient) => {
    const cfg = Config.modules.VlcPlayer;
    if (await isVlcRunning(toClient)) return true;
    
    startVlc(toClient);
    const ready = await waitVlc(toClient);
    if (ready && cfg.defaultVolume) {
        await setVolume(toClient, cfg.defaultVolume);
    }
    return ready;
};
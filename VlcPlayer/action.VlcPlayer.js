import { default as _helpers } from '../../ia/node_modules/ava-ia/helpers/index.js';

export default function (state) {
    return new Promise((resolve, reject) => {
        try {
			const sentence = (state.rawSentence || "").toLowerCase();
            const stopWords = ["stop","stoppe","arrête","arrete","coupe"];
            const stopMovie = stopWords.some(word => sentence.includes(word));

            setTimeout(() => { 
                if (stopMovie) {
                    state.action = {
                        module: 'VlcPlayer',
                        command: 'stopMovie'
                    };
                } else {
                    if (state.debug) info('Action VlcPlayer : stopMovie');
                    state.action = {
                        module: 'VlcPlayer',
                        command: state.rule
                    };
                }
                resolve(state);
            }, Config.waitAction.time);

        } catch (error) {
            reject(new Error(`Une erreur s'est produite lors du traitement de la commande VlcPlayer: ${error.message}`));
        }
    });
}

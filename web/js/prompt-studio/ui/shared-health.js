import {api} from '/scripts/api.js';
import {createHealthReader} from './polling.js';
export const readSharedHealth=createHealthReader({fetch:(...args)=>api.fetchApi(...args)});

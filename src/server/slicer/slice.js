import fs from 'fs';
import path from 'path';
import childProcess from 'child_process';

import { getPath } from 'snapmaker-luban-engine';
import logger from '../lib/logger';
import DataStorage from '../DataStorage';
import settings from '../config/settings';
import { DefinitionLoader } from './definition';
import { generateRandomPathName } from '../../shared/lib/random-utils';


const log = logger('print3d-slice');

const enginePath = getPath();


/**
     * callCuraEngine
     *
     * @param modelConfig - information needed to create new model.
     *  modelConfig = {
                configFilePath,
                path: [modelPathString]
            };
     * @param supportConfig same as modelConfig
     * @param outputPath output file path
     * @returns process
     */
function callCuraEngine(modelConfig, supportConfig, outputPath) {
    const args = ['slice', '-v', '-p', '-o', outputPath];

    if (modelConfig && modelConfig.path.length) {
        args.push('-j', modelConfig.configFilePath);
        for (const filePath of modelConfig.path) {
            args.push('-l', filePath);
        }
    }
    if (supportConfig && supportConfig.path.length) {
        for (const filePath of supportConfig.path) {
            args.push('-l', filePath);
            // notice that this config just effects the previous model
            args.push('-j', supportConfig.configFilePath);
        }
    }

    // console.log(args);
    return childProcess.spawn(
        enginePath,
        args
    );
}

let sliceProgress, filamentLength, filamentWeight, printTime;

function processGcodeHeaderAfterCuraEngine(gcodeFilePath, boundingBox, thumbnail) {
    const definitionLoader = new DefinitionLoader();
    definitionLoader.loadDefinition('active_final');
    const readFileSync = fs.readFileSync(gcodeFilePath, 'utf8');

    const date = new Date();
    const splitIndex = readFileSync.indexOf(';Generated');
    const boundingBoxMax = (boundingBox || { max: { x: 0, y: 0, z: 0 } }).max;
    const boundingBoxMin = (boundingBox || { min: { x: 0, y: 0, z: 0 } }).min;
    const header = `${';Header Start\n'
        + '\n'
        + `${readFileSync.substring(0, splitIndex)}\n`
        + ';header_type: 3dp\n'
        + `;thumbnail: ${thumbnail}\n`
        + `;file_total_lines: ${readFileSync.split('\n').length + 20}\n`
        + `;estimated_time(s): ${printTime}\n`
        + `;nozzle_temperature(°C): ${definitionLoader.settings.material_print_temperature_layer_0.default_value}\n`
        + `;build_plate_temperature(°C): ${definitionLoader.settings.material_bed_temperature_layer_0.default_value}\n`
        + `;work_speed(mm/minute): ${definitionLoader.settings.speed_infill.default_value * 60}\n`
        + `;max_x(mm): ${boundingBoxMax.x}\n`
        + `;max_y(mm): ${boundingBoxMax.y}\n`
        + `;max_z(mm): ${boundingBoxMax.z}\n`
        + `;min_x(mm): ${boundingBoxMin.x}\n`
        + `;min_y(mm): ${boundingBoxMin.y}\n`
        + `;min_z(mm): ${boundingBoxMin.z}\n`
        + '\n'
        + ';Header End\n'
        + '\n'
        + '; G-code for 3dp engraving\n'
        + '; Generated by Snapmaker Luban '}${settings.version}\n`
        + `; ${date.toDateString()} ${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}\n`
        + '\n';
    const nextSplitIndex = readFileSync.indexOf('\n', splitIndex) + 1;
    const dataLength = header.length + readFileSync.length - nextSplitIndex;
    fs.writeFileSync(gcodeFilePath, header + readFileSync.substring(nextSplitIndex));
    return dataLength;
}

function slice(params, onProgress, onSucceed, onError) {
    if (!fs.existsSync(enginePath)) {
        log.error(`Cura Engine not found: ${enginePath}`);
        onError(`Slice Error: Cura Engine not found: ${enginePath}`);
        return;
    }

    const { originalName, model, support, boundingBox, thumbnail } = params;
    const modelConfig = {
        configFilePath: `${DataStorage.configDir}/active_final.def.json`,
        path: []
    };
    for (const modelName of model) {
        const uploadPath = `${DataStorage.tmpDir}/${modelName}`;

        if (!fs.existsSync(uploadPath)) {
            log.error(`Slice Error: 3d model file does not exist -> ${uploadPath}`);
            onError(`Slice Error: 3d model file does not exist -> ${uploadPath}`);
            return;
        }
        modelConfig.path.push(uploadPath);
    }

    const supportConfig = {
        configFilePath: `${DataStorage.configDir}/support.def.json`,
        path: []
    };
    for (const modelName of support) {
        const uploadPath = `${DataStorage.tmpDir}/${modelName}`;

        if (!fs.existsSync(uploadPath)) {
            log.error(`Slice Error: 3d model file does not exist -> ${uploadPath}`);
            onError(`Slice Error: 3d model file does not exist -> ${uploadPath}`);
            return;
        }
        supportConfig.path.push(uploadPath);
    }


    const gcodeFilename = generateRandomPathName(`${path.parse(originalName).name}.gcode`);
    const gcodeFilePath = `${DataStorage.tmpDir}/${gcodeFilename}`;
    const process = callCuraEngine(modelConfig, supportConfig, gcodeFilePath);

    process.stderr.on('data', (data) => {
        const array = data.toString().split('\n');

        array.map((item) => {
            if (item.length < 10) {
                return null;
            }
            if (item.indexOf('Progress:inset+skin:') === 0 || item.indexOf('Progress:export:') === 0) {
                const start = item.indexOf('0.');
                const end = item.indexOf('%');
                sliceProgress = Number(item.slice(start, end));
                onProgress(sliceProgress);
            } else if (item.indexOf(';Filament used:') === 0) {
                filamentLength = Number(item.replace(';Filament used:', '').replace('m', ''));
                filamentWeight = Math.PI * (1.75 / 2) * (1.75 / 2) * filamentLength * 1.24;
            } else if (item.indexOf('Print time (s):') === 0) {
                // Times empirical parameter: 1.07
                printTime = Number(item.replace('Print time (s):', '')) * 1.07;
            }
            return null;
        });
    });

    process.on('close', (code) => {
        if (filamentLength && filamentWeight && printTime) {
            sliceProgress = 1;
            onProgress(sliceProgress);
            const gcodeFileLength = processGcodeHeaderAfterCuraEngine(gcodeFilePath, boundingBox, thumbnail);

            onSucceed({
                gcodeFilename: gcodeFilename,
                gcodeFileLength: gcodeFileLength,
                printTime: printTime,
                filamentLength: filamentLength,
                filamentWeight: filamentWeight,
                gcodeFilePath: gcodeFilePath
            });
        }
        log.info(`slice progress closed with code ${code}`);
    });
}

export default slice;

const cloud = require('wx-server-sdk');
const db = cloud.database();

// 初始化云存储
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const SAVE_ROOT = 'saves';
const GAME_ROOT = 'games';
const FILE_ID_COLLECTION = 'file_mappings';

/**
 * 获取存档文件云路径
 */
function getSaveCloudPath(user_id, game_id, save_id, filename) {
  return `${SAVE_ROOT}/${user_id}/${game_id}/${save_id}/${filename}.md`;
}

/**
 * 获取共享游戏文件云路径
 */
function getGameCloudPath(game_id, filename) {
  return `${GAME_ROOT}/${game_id}/${filename}`;
}

/**
 * 根据云路径获取fileID（查询映射表）
 */
async function getFileIdByCloudPath(cloudPath) {
  try {
    const res = await db.collection(FILE_ID_COLLECTION).where({ cloud_path: cloudPath }).limit(1).get();
    if (res.data.length > 0) {
      return res.data[0].file_id;
    }
    return null;
  } catch (e) {
    console.error('Get fileID failed:', cloudPath, e.message);
    return null;
  }
}

/**
 * 记录cloudPath到fileID的映射
 */
async function saveFileIdMapping(cloudPath, fileId) {
  try {
    // 先检查是否存在
    const existing = await db.collection(FILE_ID_COLLECTION).where({ cloud_path: cloudPath }).limit(1).get();
    if (existing.data.length > 0) {
      await db.collection(FILE_ID_COLLECTION).doc(existing.data[0]._id).update({
        data: { file_id: fileId, updated_at: db.serverDate() }
      });
    } else {
      await db.collection(FILE_ID_COLLECTION).add({
        data: {
          cloud_path: cloudPath,
          file_id: fileId,
          created_at: db.serverDate(),
          updated_at: db.serverDate(),
        }
      });
    }
  } catch (e) {
    console.error('Save fileID mapping failed:', cloudPath, e.message);
  }
}

/**
 * 读取云存储文件
 * @param {string} cloudPath - 云存储路径（不是fileID）
 * @returns {Promise<string|null>} 文件内容，不存在返回null
 */
async function readCloudFile(cloudPath) {
  try {
    // 先查找fileID
    let fileID = await getFileIdByCloudPath(cloudPath);

    if (!fileID) {
      return null;
    }

    const res = await cloud.downloadFile({ fileID });
    if (res.statusCode === 200) {
      return res.fileContent.toString('utf8');
    }
    return null;
  } catch (e) {
    // 文件不存在
    if (e.errCode === -404011 || e.errCode === -601004 || e.message?.includes('not exist')) {
      return null;
    }
    console.error('Read cloud file failed:', cloudPath, e.message);
    return null;
  }
}

/**
 * 写入云存储文件
 * @param {string} cloudPath - 云存储路径
 * @param {string} content - 文件内容
 * @returns {Promise<string>} fileID
 */
async function writeCloudFile(cloudPath, content) {
  try {
    const buffer = Buffer.from(content, 'utf8');
    const res = await cloud.uploadFile({
      cloudPath,
      fileContent: buffer,
    });
    // 保存映射
    await saveFileIdMapping(cloudPath, res.fileID);
    return res.fileID;
  } catch (e) {
    console.error('Write cloud file failed:', cloudPath, e.message);
    throw e;
  }
}

/**
 * 删除云存储文件
 */
async function deleteCloudFile(cloudPath) {
  try {
    const fileID = await getFileIdByCloudPath(cloudPath);
    if (fileID) {
      await cloud.deleteFile({
        fileList: [fileID],
      });
      // 删除映射记录
      const existing = await db.collection(FILE_ID_COLLECTION).where({ cloud_path: cloudPath }).limit(1).get();
      if (existing.data.length > 0) {
        await db.collection(FILE_ID_COLLECTION).doc(existing.data[0]._id).remove();
      }
    }
  } catch (e) {
    console.error('Delete cloud file failed:', cloudPath, e.message);
  }
}

/**
 * 删除目录下所有文件（用于删除存档）
 */
async function deleteCloudDirectory(dirPrefix) {
  try {
    const res = await db.collection(FILE_ID_COLLECTION).where({
      cloud_path: db.RegExp({ regexp: `^${dirPrefix}`, options: 'i' })
    }).get();

    if (res.data.length > 0) {
      const fileIds = res.data.map(r => r.file_id);
      await cloud.deleteFile({ fileList: fileIds });
      // 批量删除映射
      for (const record of res.data) {
        await db.collection(FILE_ID_COLLECTION).doc(record._id).remove();
      }
    }
  } catch (e) {
    console.error('Delete cloud directory failed:', dirPrefix, e.message);
  }
}

/**
 * 读取存档文件
 */
async function readSaveFile(user_id, game_id, save_id, filename) {
  const path = getSaveCloudPath(user_id, game_id, save_id, filename);
  return readCloudFile(path);
}

/**
 * 写入存档文件
 */
async function writeSaveFile(user_id, game_id, save_id, filename, content) {
  const path = getSaveCloudPath(user_id, game_id, save_id, filename);
  return writeCloudFile(path, content);
}

/**
 * 追加内容到存档文件
 */
async function appendToSaveFile(user_id, game_id, save_id, filename, contentToAppend) {
  const existing = await readSaveFile(user_id, game_id, save_id, filename) || '';
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  const newContent = existing + separator + contentToAppend + '\n';
  return writeSaveFile(user_id, game_id, save_id, filename, newContent);
}

/**
 * 读取共享游戏文件
 */
async function readGameFile(game_id, filename) {
  const path = getGameCloudPath(game_id, filename);
  return readCloudFile(path);
}

module.exports = {
  SAVE_ROOT,
  GAME_ROOT,
  FILE_ID_COLLECTION,
  getSaveCloudPath,
  getGameCloudPath,
  readCloudFile,
  writeCloudFile,
  deleteCloudFile,
  deleteCloudDirectory,
  readSaveFile,
  writeSaveFile,
  appendToSaveFile,
  readGameFile,
};


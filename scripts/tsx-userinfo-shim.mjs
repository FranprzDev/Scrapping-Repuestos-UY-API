import os from 'node:os';

const originalUserInfo = os.userInfo;

os.userInfo = function userInfoWithFallback(options) {
  try {
    return originalUserInfo.call(os, options);
  } catch {
    const username = process.env.USERNAME || process.env.USER || 'codex';
    return {
      uid: -1,
      gid: -1,
      username,
      homedir: process.env.USERPROFILE || process.env.HOME || os.tmpdir(),
      shell: null,
    };
  }
};

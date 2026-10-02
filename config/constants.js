const ROLES = { ADMIN: 'admin', TEACHER: 'teacher', STUDENT: 'student' };

const RESOURCE_TYPES = {
  PDF:'pdf', VIDEO:'video', AUDIO:'audio', IMAGE:'image',
  SLIDE:'slide', DOC:'doc', MARKDOWN:'markdown',
  HTML:'html', ARCHIVE:'archive', OTHER:'other'
};

const FILE_TYPE_MAP = {
  '.pdf':'pdf','.mp4':'video','.webm':'video','.mov':'video',
  '.mp3':'audio','.wav':'audio',
  '.jpg':'image','.jpeg':'image','.png':'image','.gif':'image','.webp':'image',
  '.ppt':'slide','.pptx':'slide','.doc':'doc','.docx':'doc',
  '.md':'markdown','.html':'html','.zip':'archive','.rar':'archive','.7z':'archive'
};

const DEFAULT_SETTINGS = {
  theme:'light', language:'en',
  email_notifications:'true', push_notifications:'true',
  course_updates:'true', quiz_releases:'true',
  messages:'true', profile_visibility:'classmates'
};

module.exports = { ROLES, RESOURCE_TYPES, FILE_TYPE_MAP, DEFAULT_SETTINGS };
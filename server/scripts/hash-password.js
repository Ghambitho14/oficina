// Uso: npm run hash-password -- "mi-contraseña-segura"
// Imprime el hash bcrypt en base64 (sin símbolos "$", que Docker/Coolify intentan interpretar como variables).
import bcrypt from 'bcryptjs';

const password = process.argv[2];
if (!password) {
  console.error('Uso: npm run hash-password -- "tu-contraseña"');
  process.exit(1);
}
console.log(Buffer.from(bcrypt.hashSync(password, 12)).toString('base64'));

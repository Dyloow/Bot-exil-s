import fs from 'fs/promises';
import path from 'path';
import { EmbedBuilder } from 'discord.js';
import cron from 'node-cron';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class SalaryChecker {
  constructor(logger, config) {
    this.logger = logger;
    this.config = config;
    this.dataPath = path.join(__dirname, '..', 'data', 'salaries.json');
    this.referenceSalary = config.get('salaryChecker.referenceSalary') || 45000;
    this.referenceUser = config.get('salaryChecker.referenceUser') || 'Toto';
    this.startDate = '2025-12-16';
    this.client = null;
    this.cronTask = null;
    this.data = {
      salaries: {},
      reminders: {}
    };
  }

  async initialize(client) {
    this.client = client;

    try {
      const dataDir = path.dirname(this.dataPath);
      await fs.mkdir(dataDir, { recursive: true });

      try {
        const fileContent = await fs.readFile(this.dataPath, 'utf8');
        this.data = JSON.parse(fileContent);
        this.logger.info('Salary data loaded successfully', {
          userCount: Object.keys(this.data.salaries).length
        });
      } catch (error) {
        if (error.code === 'ENOENT') {
          this.data.salaries = {};
          this.data.reminders = {};
          await this.saveData();
          this.logger.info('Salary checker initialized with empty data');
        } else {
          throw error;
        }
      }

      // Ensure reminders object exists for backward compatibility
      if (!this.data.reminders) {
        this.data.reminders = {};
      }

      this.setupDailyReminder();

    } catch (error) {
      this.logger.error('Failed to initialize SalaryChecker', { error: error.message });
      throw error;
    }
  }

  setupDailyReminder() {
    const cronTime = this.config.get('salaryChecker.dailyReminderTime') || '09:00';
    const [hour, minute] = cronTime.split(':');

    this.cronTask = cron.schedule(`${minute} ${hour} * * *`, async () => {
      await this.sendDailyReminder();
    });

    this.logger.info('Daily salary reminder scheduled', { time: cronTime });
  }

  async sendDailyReminder() {
    try {
      const guildId = this.config.get('server.guildId');
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) {
        this.logger.error('Guild not found for daily reminder');
        return;
      }

      // Loop through all users with reminders enabled
      const reminderEntries = Object.entries(this.data.reminders);

      if (reminderEntries.length === 0) {
        this.logger.info('No active reminders to send');
        return;
      }

      for (const [pseudo, reminderData] of reminderEntries) {
        try {
          // Check if user has a salary
          if (!this.data.salaries[pseudo]) {
            this.logger.warn('User has reminder but no salary', { pseudo });
            continue;
          }

          // Fetch the member
          let targetMember;
          try {
            targetMember = await guild.members.fetch(reminderData.userId);
          } catch (error) {
            this.logger.warn('User not found in guild for reminder', { pseudo, userId: reminderData.userId, error: error.message });
            continue;
          }

          if (!targetMember) {
            this.logger.warn('Member object is null', { pseudo });
            continue;
          }

          // Calculate difference
          const userSalary = this.data.salaries[pseudo];
          const difference = this.calculateDifference(userSalary);

          const timeElapsed = `${difference.daysSinceStart}d ${difference.hours}h ${difference.minutes}m ${difference.seconds}s`;
          const secondsPerYear = 365 * 24 * 60 * 60;
          const perSecondDiff = difference.annualDifference / secondsPerYear;

          const embed = new EmbedBuilder()
            .setColor(difference.totalDifference >= 0 ? '#00FF00' : '#FF0000')
            .setTitle('💰 Daily Salary Reminder')
            .setDescription(`Hey ${targetMember.user.username}! Here's your daily reminder of what you're missing out on...`)
            .addFields(
              { name: 'Your Salary', value: this.formatCurrency(userSalary) + '/year', inline: true },
              { name: `${this.referenceUser}'s Salary`, value: this.formatCurrency(this.referenceSalary) + '/year', inline: true },
              { name: 'Difference/Second', value: this.formatCurrency(perSecondDiff) + '/s', inline: true },
              { name: '⏱️ Time Elapsed', value: timeElapsed, inline: true },
              { name: '🔢 Total Seconds', value: difference.secondsSinceStart.toLocaleString('fr-FR'), inline: true },
              { name: '💸 Total Lost', value: this.formatCurrency(Math.abs(difference.totalDifference)), inline: true }
            )
            .setFooter({ text: `Start date: ${new Date(this.startDate).toLocaleDateString('fr-FR')}` })
            .setTimestamp();

          if (difference.totalDifference > 0) {
            embed.addFields({
              name: '📈 Reality Check',
              value: `If you had joined ${this.referenceUser}'s firm on **${new Date(this.startDate).toLocaleDateString('fr-FR')}**, you would have earned **${this.formatCurrency(Math.abs(difference.totalDifference))} more** by now! 💰`
            });
          }

          // Try to send DM
          try {
            await targetMember.send({ embeds: [embed] });
            this.logger.info('Daily reminder sent', { pseudo, userId: reminderData.userId, difference: difference.totalDifference });
          } catch (dmError) {
            this.logger.warn('Could not send DM, sending in guild channel', { pseudo, userId: reminderData.userId, error: dmError.message });

            const channel = guild.channels.cache.find(ch => ch.name === 'general' || ch.type === 0);
            if (channel) {
              await channel.send({ content: `<@${targetMember.id}>`, embeds: [embed] });
            }
          }

        } catch (error) {
          this.logger.error('Error sending reminder to user', { pseudo, error: error.message });
        }
      }

    } catch (error) {
      this.logger.error('Error in sendDailyReminder', { error: error.message });
    }
  }

  async saveData() {
    try {
      await fs.writeFile(this.dataPath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (error) {
      this.logger.error('Failed to save salary data', { error: error.message });
      throw error;
    }
  }

  async handleCheckHessCommand(message, args) {
    try {
      if (args.length === 0) {
        await message.reply('Usage: `!check_hess [pseudo]` - Check salary difference for a user');
        return;
      }

      // Handle both @mentions and plain usernames
      let pseudo;
      const mentionedUser = message.mentions.users.first();
      if (mentionedUser) {
        pseudo = mentionedUser.username.toLowerCase();
      } else {
        pseudo = args[0].toLowerCase();
      }

      this.logger.info('Checking salary for user', {
        pseudo,
        availableUsers: Object.keys(this.data.salaries),
        hasSalary: !!this.data.salaries[pseudo]
      });

      if (!this.data.salaries[pseudo]) {
        await message.reply(`No salary data found for **${pseudo}**. They need to set their salary first using \`!add_salary [amount]\`.`);
        return;
      }

      const userSalary = this.data.salaries[pseudo];
      const difference = this.calculateDifference(userSalary);

      const timeElapsed = `${difference.daysSinceStart}d ${difference.hours}h ${difference.minutes}m ${difference.seconds}s`;

      const embed = new EmbedBuilder()
        .setColor(difference.totalDifference >= 0 ? '#00FF00' : '#FF0000')
        .setTitle(`💰 Salary Comparison for ${pseudo}`)
        .setDescription(`Comparing against ${this.referenceUser}'s reference salary of **${this.formatCurrency(this.referenceSalary)}**/year`)
        .addFields(
          { name: 'Current Salary', value: this.formatCurrency(userSalary) + '/year', inline: true },
          { name: 'Reference Salary', value: this.formatCurrency(this.referenceSalary) + '/year', inline: true },
          { name: 'Annual Difference', value: this.formatCurrency(difference.annualDifference) + '/year', inline: true },
          { name: '⏱️ Time Elapsed', value: timeElapsed, inline: true },
          { name: '🔢 Total Seconds', value: difference.secondsSinceStart.toLocaleString('fr-FR'), inline: true },
          { name: '💸 Total Difference', value: this.formatCurrency(difference.totalDifference), inline: true }
        )
        .setFooter({ text: `Start date: ${new Date(this.startDate).toLocaleDateString('fr-FR')}` })
        .setTimestamp();

      if (difference.totalDifference > 0) {
        embed.addFields({
          name: '📈 Result',
          value: `**${pseudo}** would have earned **${this.formatCurrency(Math.abs(difference.totalDifference))} more** with ${this.referenceUser}'s salary!`
        });
      } else if (difference.totalDifference < 0) {
        embed.addFields({
          name: '📉 Result',
          value: `**${pseudo}** would have earned **${this.formatCurrency(Math.abs(difference.totalDifference))} less** with ${this.referenceUser}'s salary.`
        });
      } else {
        embed.addFields({
          name: '⚖️ Result',
          value: `**${pseudo}** has the same salary as ${this.referenceUser}!`
        });
      }

      await message.reply({ embeds: [embed] });
      this.logger.info('Salary check performed', { pseudo, difference: difference.totalDifference });

    } catch (error) {
      this.logger.error('Error in handleCheckHessCommand', { error: error.message });
      await message.reply('An error occurred while checking the salary. Please try again.');
    }
  }

  async handleAddSalaryCommand(message, args) {
    try {
      if (args.length < 1) {
        await message.reply('Usage: `!add_salary [annual_amount]` - Set your own annual salary. Example: `!add_salary 42000`');
        return;
      }

      const salary = parseFloat(args[0]);

      if (isNaN(salary) || salary < 0) {
        await message.reply('Please provide a valid salary amount (positive number).');
        return;
      }

      const pseudo = message.author.username.toLowerCase();
      const isUpdate = this.data.salaries[pseudo] !== undefined;

      this.logger.info('Adding/updating salary', {
        pseudo,
        salary,
        isUpdate,
        authorUsername: message.author.username,
        authorUsernameLC: message.author.username.toLowerCase()
      });

      this.data.salaries[pseudo] = salary;
      await this.saveData();

      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle(isUpdate ? '✅ Salary Updated' : '✅ Salary Added')
        .setDescription(`Your salary has been ${isUpdate ? 'updated to' : 'set to'} **${this.formatCurrency(salary)}**/year`)
        .setTimestamp();

      await message.reply({ embeds: [embed] });
      this.logger.info('Salary added/updated', { pseudo, salary, isUpdate });

    } catch (error) {
      this.logger.error('Error in handleAddSalaryCommand', { error: error.message });
      await message.reply('An error occurred while adding the salary. Please try again.');
    }
  }

  async handleListSalariesCommand(message) {
    try {
      const salaries = Object.entries(this.data.salaries);

      if (salaries.length === 0) {
        await message.reply('No salaries have been added yet. Use `!add_salary [amount]` to add yours.');
        return;
      }

      const salaryList = salaries
        .sort((a, b) => b[1] - a[1])
        .map(([pseudo, salary], index) => {
          const diff = salary - this.referenceSalary;
          const icon = diff > 0 ? '📈' : diff < 0 ? '📉' : '⚖️';
          const hasReminder = this.data.reminders[pseudo] ? '🔔' : '';
          return `${index + 1}. **${pseudo}**: ${this.formatCurrency(salary)}/year ${icon} ${hasReminder}`;
        })
        .join('\n');

      const embed = new EmbedBuilder()
        .setColor('#0099FF')
        .setTitle('💼 Salary List')
        .setDescription(salaryList)
        .addFields({
          name: `Reference Salary (${this.referenceUser})`,
          value: this.formatCurrency(this.referenceSalary) + '/year'
        })
        .setFooter({ text: `Start date: ${new Date(this.startDate).toLocaleDateString('fr-FR')} | 🔔 = Daily reminder active` })
        .setTimestamp();

      await message.reply({ embeds: [embed] });

    } catch (error) {
      this.logger.error('Error in handleListSalariesCommand', { error: error.message });
      await message.reply('An error occurred while listing salaries. Please try again.');
    }
  }

  async handleRemindCommand(message, args) {
    try {
      if (args.length === 0) {
        await message.reply('Usage: `!remind [pseudo]` or `!remind @user` - Enable daily salary reminder for a user');
        return;
      }

      // Handle both @mentions and plain usernames
      let pseudo;
      let userId;
      const mentionedUser = message.mentions.users.first();

      if (mentionedUser) {
        pseudo = mentionedUser.username.toLowerCase();
        userId = mentionedUser.id;
      } else {
        pseudo = args[0].toLowerCase();

        // Try to find the user by username in the guild
        const guild = message.guild;
        const members = await guild.members.fetch();
        const foundMember = members.find(m => m.user.username.toLowerCase() === pseudo);

        if (!foundMember) {
          await message.reply(`❌ User **${pseudo}** not found in this server. Try mentioning them with @.`);
          return;
        }

        userId = foundMember.user.id;
      }

      // Check if user has a salary set
      if (!this.data.salaries[pseudo]) {
        await message.reply(`❌ **${pseudo}** doesn't have a salary set yet. They need to use \`!add_salary [amount]\` first.`);
        return;
      }

      // Check if reminder already exists
      if (this.data.reminders[pseudo]) {
        await message.reply(`❌ Daily reminder is already enabled for **${pseudo}**.`);
        return;
      }

      // Add reminder
      this.data.reminders[pseudo] = {
        userId: userId,
        enabledBy: message.author.id,
        enabledAt: new Date().toISOString()
      };
      await this.saveData();

      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('🔔 Daily Reminder Enabled')
        .setDescription(`Daily salary reminder has been enabled for **${pseudo}**`)
        .addFields(
          { name: 'Reminder Time', value: this.config.get('salaryChecker.dailyReminderTime') || '09:00', inline: true },
          { name: 'User ID', value: userId, inline: true }
        )
        .setTimestamp();

      await message.reply({ embeds: [embed] });
      this.logger.info('Daily reminder enabled', { pseudo, userId, enabledBy: message.author.id });

    } catch (error) {
      this.logger.error('Error in handleRemindCommand', { error: error.message });
      await message.reply('An error occurred while setting up the reminder. Please try again.');
    }
  }

  calculateDifference(userSalary) {
    const startDate = new Date(this.startDate);
    const now = new Date();
    const millisecondsSinceStart = now - startDate;
    const secondsSinceStart = Math.floor(millisecondsSinceStart / 1000);

    // Calculate time breakdown
    const daysSinceStart = Math.floor(secondsSinceStart / (24 * 60 * 60));
    const hours = Math.floor((secondsSinceStart % (24 * 60 * 60)) / (60 * 60));
    const minutes = Math.floor((secondsSinceStart % (60 * 60)) / 60);
    const seconds = secondsSinceStart % 60;

    const annualDifference = this.referenceSalary - userSalary;
    const secondsPerYear = 365 * 24 * 60 * 60; // 31,536,000 seconds
    const totalDifference = annualDifference * (secondsSinceStart / secondsPerYear);

    return {
      secondsSinceStart,
      daysSinceStart,
      hours,
      minutes,
      seconds,
      annualDifference,
      totalDifference
    };
  }

  formatCurrency(amount) {
    return new Intl.NumberFormat('fr-FR', {
      style: 'currency',
      currency: 'EUR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  }

  destroy() {
    if (this.cronTask) {
      this.cronTask.stop();
      this.logger.info('Daily salary reminder stopped');
    }
  }
}

export default SalaryChecker;

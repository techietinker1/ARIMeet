-- CreateTable
CREATE TABLE `MeetingSession` (
    `id` VARCHAR(191) NOT NULL,
    `meetingId` VARCHAR(191) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `endedAt` DATETIME(3) NULL,
    `durationMs` INTEGER NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MeetingParticipant` (
    `id` VARCHAR(191) NOT NULL,
    `meetingId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NULL,
    `displayName` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NULL,
    `joinedAt` DATETIME(3) NOT NULL,
    `leftAt` DATETIME(3) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BreakoutRoom` (
    `id` VARCHAR(191) NOT NULL,
    `meetingId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NULL,
    `breakoutKey` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `createdBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL,
    `closedAt` DATETIME(3) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `BreakoutParticipant` (
    `id` VARCHAR(191) NOT NULL,
    `breakoutRoomId` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NULL,
    `joinedAt` DATETIME(3) NOT NULL,
    `leftAt` DATETIME(3) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Recording` (
    `id` VARCHAR(191) NOT NULL,
    `meetingId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NULL,
    `type` ENUM('AUDIO', 'MEETING') NOT NULL,
    `userName` VARCHAR(191) NULL,
    `userEmail` VARCHAR(191) NULL,
    `filePath` VARCHAR(191) NOT NULL,
    `fileName` VARCHAR(191) NOT NULL,
    `savedAt` DATETIME(3) NOT NULL,
    `startedAt` DATETIME(3) NULL,
    `endedAt` DATETIME(3) NULL,
    `durationMs` INTEGER NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RecordingTranscript` (
    `id` VARCHAR(191) NOT NULL,
    `recordingId` VARCHAR(191) NOT NULL,
    `text` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `RecordingTranscript_recordingId_key`(`recordingId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `MeetingSession` ADD CONSTRAINT `MeetingSession_meetingId_fkey` FOREIGN KEY (`meetingId`) REFERENCES `Meeting`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MeetingParticipant` ADD CONSTRAINT `MeetingParticipant_meetingId_fkey` FOREIGN KEY (`meetingId`) REFERENCES `Meeting`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MeetingParticipant` ADD CONSTRAINT `MeetingParticipant_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `MeetingSession`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BreakoutRoom` ADD CONSTRAINT `BreakoutRoom_meetingId_fkey` FOREIGN KEY (`meetingId`) REFERENCES `Meeting`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BreakoutRoom` ADD CONSTRAINT `BreakoutRoom_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `MeetingSession`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `BreakoutParticipant` ADD CONSTRAINT `BreakoutParticipant_breakoutRoomId_fkey` FOREIGN KEY (`breakoutRoomId`) REFERENCES `BreakoutRoom`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Recording` ADD CONSTRAINT `Recording_meetingId_fkey` FOREIGN KEY (`meetingId`) REFERENCES `Meeting`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Recording` ADD CONSTRAINT `Recording_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `MeetingSession`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RecordingTranscript` ADD CONSTRAINT `RecordingTranscript_recordingId_fkey` FOREIGN KEY (`recordingId`) REFERENCES `Recording`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

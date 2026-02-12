pipeline {
    agent any
    stages {
        stage('Build Docker Image') {
            steps {
                // Belépünk az 'app' mappába és ott építjük a képet
                sh 'docker build -t my-node-app:latest ./app'
            }
        }
        stage('Deploy to K8s') {
            steps {
                // Letöltjük a kubectl-t ideiglenesen
                sh 'curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"'
                sh 'chmod +x kubectl'
                
                // Frissítjük a deploymentet.
                // A 'rollout restart' parancs kényszeríti a podok cseréjét az új képre.
                sh './kubectl rollout restart deployment backend-deployment'
            }
        }
    }
}